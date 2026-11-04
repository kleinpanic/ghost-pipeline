"use strict";

/**
 * ghost-pipeline-e2e.test.js — Ghost Pipeline End-to-End Tests (native transport, NAT-25)
 *
 * Runs `ghost serve` (cmdServe) against fakes at the process boundary only:
 *   - spawn(GHOST_IMSG_CLI, ["rpc"])  → a fake `imsg rpc` JSON-RPC 2.0 session
 *   - execFile(GHOST_OPENCLAW_BIN, …) → fake `openclaw gateway call plugin.approval.request`
 *                                       and `openclaw message send --channel imessage`
 *   - spawn("curl", …)                → Discord
 *   - nock                            → OpenRouter, embeddings, Spark
 * Everything between them is the real code: the watch, the normalizer, the inbound handler,
 * preflight, drafting, the approval request, the send chokepoint and the rate gate.
 *
 * Usage:
 *   npm run e2e        ← FORCE=1 repo-scope-guard + jest --runInBand
 *
 * Flows covered:
 *   1. Startup        → watch.subscribe over `imsg rpc`, orphaned drafts expire unsent
 *   2. Reaction/group → no draft, no approval, no send
 *   3. Message → draft → approval card → Allow Once → native send (exact argv)
 *   4. Deny, expiry, and approval-transport failure → never a send
 *   5. Klein replies (is_from_me) → pending and posted drafts cancelled, late approval inert
 *   6. Unknown number → native approval card → Deny → denylisted
 *   7. Security gates: drift marker, rate limit, native send failure not retried
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ─── Repo scope guard ────────────────────────────────────────────────────────
const REPO = __dirname + "/../..";
const SCOPE_GUARD = `${REPO}/../../../.openclaw/hooks/repo-scope-guard.sh`;
// The guard only exists on the dev machine; elsewhere (CI, fresh clones) there is nothing to run.
if (process.env.FORCE !== "1" && fs.existsSync(SCOPE_GUARD)) {
  const { execSync } = require("child_process");
  try {
    const result = execSync(
      `${SCOPE_GUARD} dev "${REPO}"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    if (!result.trim().startsWith("SCOPE_OK")) throw new Error(result);
  } catch (err) {
    const msg = (err.message || "").trim();
    if (!msg.startsWith("SCOPE_OK")) {
      console.error(`repo-scope-guard: ${msg}`);
      process.exit(1);
    }
  }
}

// ─── Temp workspace ─────────────────────────────────────────────────────────
const tmpHome   = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-e2e-"));
const CHANNEL   = "100000000000000001";
process.env.HOME               = tmpHome;
process.env.GHOST_PORT         = "0";              // ephemeral port for the status server
process.env.GHOST_CHANNEL_ID   = CHANNEL;
process.env.OWNER_PHONE        = "12673479614";
process.env.GHOST_IMSG_CLI     = "/e2e/fake/imsg-ssh";
process.env.GHOST_OPENCLAW_BIN = "/e2e/fake/openclaw";
// 90-03: sending is fail-closed by default. Enable the master send toggle for these
// flows; toggle-specific behavior is pinned in tests/unit/sendToggleStyleGate.test.js.
process.env.GHOST_SEND_ENABLED = "1";

const ghostWsDir = path.join(tmpHome, ".openclaw", "workspace-ghost");
const dataDir     = path.join(tmpHome, ".openclaw", "data");

fs.mkdirSync(path.join(ghostWsDir, "governance"), { recursive: true });
fs.mkdirSync(path.join(ghostWsDir, "memory", "contacts"), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".config", "openrouter"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".config", "discord"),    { recursive: true });
fs.writeFileSync(path.join(tmpHome, ".config", "openrouter", "api-key"), "test-key");
fs.writeFileSync(path.join(tmpHome, ".config", "discord",    "bot-token"), "test-token");

const ALLOWED_PHONE = "15551234567";
const SECOND_PHONE  = "15552222222";
const UNKNOWN_PHONE = "15559990000";
// imsg chat ids (chat.db ROWIDs) for the three 1:1 threads
const CHAT = { [ALLOWED_PHONE]: 1, [SECOND_PHONE]: 2, [UNKNOWN_PHONE]: 3 };

fs.writeFileSync(
  path.join(ghostWsDir, "governance", "CONTACTS.md"),
  [
    "# Test Contacts",
    "<!-- CONTACT_ALLOWLIST_START -->",
    `- Test User | +${ALLOWED_PHONE}  | ask | friend | Test User`,
    `- Second User | +${SECOND_PHONE} | ask | friend | Second User`,
    "<!-- CONTACT_ALLOWLIST_END -->",
  ].join("\n") + "\n"
);
fs.writeFileSync(path.join(ghostWsDir, "SOUL.md"), "You are Klein. Be brief.");

// ─── Fake process state (read by the child_process mock) ────────────────────
global.__ghostDiscordLog = [];
global.__ghostSendLog    = [];   // openclaw message send invocations
global.__ghostApprovals  = [];   // open plugin.approval.request invocations
global.__imsgSpawns      = [];   // spawn(GHOST_IMSG_CLI, argv)
global.__imsgRpcLog      = [];   // every JSON-RPC request written to imsg rpc
global.__imsgState       = { watchProc: null, history: {}, chats: [] };
global.__ghostSendReply  = null; // override for the next sends: { err, stdout }
global.__ghostApprovalFail = false;

// ─── Mock child_process ─────────────────────────────────────────────────────
jest.mock("child_process", () => {
  const { EventEmitter } = require("events");
  const actual = jest.requireActual("child_process");

  const createChild = (stdoutData, exitCode = 0) => {
    const child  = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin  = { write: jest.fn(), end: jest.fn() };
    // setImmediate, not process.nextTick, so fake timers don't break the mock
    setImmediate(() => {
      child.stdout.emit("data", typeof stdoutData === "string" ? stdoutData : JSON.stringify(stdoutData));
      child.emit("close", exitCode);
    });
    return child;
  };

  // A fake `imsg rpc`: one JSON-RPC 2.0 object per line on stdin, replies on stdout.
  const createImsgRpc = () => {
    const proc   = new EventEmitter();
    proc.stdout  = new EventEmitter();
    proc.stderr  = new EventEmitter();
    const reply  = (obj) => setImmediate(() => proc.stdout.emit("data", JSON.stringify(obj) + "\n"));
    proc.stdin = {
      write: (line) => {
        const req = JSON.parse(line);
        global.__imsgRpcLog.push(req);
        const st = global.__imsgState;
        if (req.method === "watch.subscribe") {
          st.watchProc = proc;
          reply({ jsonrpc: "2.0", id: req.id, result: { subscription: 1 } });
        } else if (req.method === "messages.history") {
          reply({ jsonrpc: "2.0", id: req.id, result: { messages: st.history[req.params.chat_id] || [] } });
        } else if (req.method === "chats.list") {
          reply({ jsonrpc: "2.0", id: req.id, result: { chats: st.chats } });
        } else {
          reply({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } });
        }
        return true;
      },
      end: () => {},
    };
    proc.kill = () => { setImmediate(() => proc.emit("close", 0)); return true; };
    return proc;
  };

  return {
    ...actual,
    spawn: jest.fn((cmd, args) => {
      if (cmd === process.env.GHOST_IMSG_CLI) {
        global.__imsgSpawns.push([...(args || [])]);
        return createImsgRpc();
      }
      if (cmd === "curl") {
        const isDelete = args.includes("DELETE");
        const urlArg   = args.find(a => typeof a === "string" && a.includes("discord.com"));
        global.__ghostDiscordLog.push({ method: isDelete ? "DELETE" : "POST_OR_GET", url: urlArg });
        return createChild(isDelete ? "" : { id: `msg-${Date.now()}` });
      }
      return createChild("{}");
    }),
    execFile: jest.fn((bin, args, opts, cb) => {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      if (bin !== process.env.GHOST_OPENCLAW_BIN) {
        setImmediate(() => cb(new Error(`unexpected execFile ${bin}`), "", ""));
        return;
      }
      if (args[0] === "gateway" && args[2] === "plugin.approval.request") {
        if (global.__ghostApprovalFail) {
          setImmediate(() => cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "gateway closed (1006)"));
          return;
        }
        const params = JSON.parse(args[args.indexOf("--params") + 1]);
        global.__ghostApprovals.push({ args: [...args], params, cb });
        return; // stays open until the test answers it
      }
      if (args[0] === "message" && args[1] === "send") {
        global.__ghostSendLog.push({
          args: [...args],
          target:  args[args.indexOf("--target") + 1],
          message: args[args.indexOf("--message") + 1],
        });
        const r = global.__ghostSendReply || {
          err: null, stdout: JSON.stringify({ ok: true, channel: "imessage", messageId: "e2e-msg-1" }),
        };
        setImmediate(() => cb(r.err, r.stdout, ""));
        return;
      }
      setImmediate(() => cb(new Error(`unexpected openclaw ${args.slice(0, 3).join(" ")}`), "", ""));
    }),
    spawnSync: actual.spawnSync,
  };
});

// ─── nock setup ─────────────────────────────────────────────────────────────
const nock = require("nock");

function setupNock() {
  nock.disableNetConnect();
  global.__ghostORResponse = global.__ghostORResponse || {
    choices: [{ message: { content: "That works for me." } }],
  };
  nock("https://openrouter.ai")
    .persist()
    .post("/api/v1/chat/completions")
    .reply(200, () => global.__ghostORResponse);

  nock("https://generativelanguage.googleapis.com")
    .persist()
    .post(/embedContent/)
    .replyWithError("not-available");

  nock("http://127.0.0.1:18080")
    .persist()
    .get("/v1/models")
    .replyWithError("ECONNREFUSED");
}

// ─── Require ghost ──────────────────────────────────────────────────────────
const ghost = require("../../src/ghost");

// ─── Helpers ────────────────────────────────────────────────────────────────
async function until(fn, timeoutMs = 5000, what = "condition") {
  // Date.now is pinned by fake timers in beforeEach, so count polls instead of reading the clock.
  for (let i = 0; i < timeoutMs / 20; i++) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  if (!fn()) throw new Error(`timed out waiting for ${what}`);
}
const settle = (ms = 150) => new Promise(r => setTimeout(r, ms));

let rowid = 1000;
/** An imsg message payload (extensions/imessage/src/monitor/types.ts shape). */
function rawMsg({
  phone = ALLOWED_PHONE, text = "Hey, are you free this weekend?",
  isFromMe = false, isReaction = false, isGroup = false, createdAt = Date.now(),
} = {}) {
  rowid++;
  return {
    id: rowid, guid: `e2e-guid-${rowid}`, chat_id: CHAT[phone],
    chat_guid: `iMessage;-;+${phone}`, chat_identifier: `+${phone}`,
    sender: `+${phone}`, sender_name: "", text,
    is_from_me: isFromMe, is_reaction: isReaction, is_group: isGroup,
    created_at: new Date(createdAt).toISOString(),
  };
}

/** Emit one watch notification on the live imsg rpc session. */
function pushInbound(raw) {
  const proc = global.__imsgState.watchProc;
  if (!proc) throw new Error("no live imsg watch session");
  proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", method: "message", params: { message: raw } }) + "\n");
}

async function nextApproval(n = 1) {
  await until(() => global.__ghostApprovals.length >= n, 5000, `approval request #${n}`);
  return global.__ghostApprovals[n - 1];
}

/** Answer an open plugin.approval.request the way the Gateway does when it resolves. */
function answer(approval, decision) {
  approval.cb(null, JSON.stringify({ id: "plugin:e2e", decision, createdAtMs: 0, expiresAtMs: 0 }), "");
}

function readFeedback() {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, "ghost-feedback.json"), "utf8")); }
  catch { return []; }
}

function seedDraft(over = {}) {
  const phone = over.phone || ALLOWED_PHONE;
  const draft = {
    draftId:     over.draftId || `e2e-${Math.random().toString(36).slice(2, 10)}`,
    messageId:   "discord-msg-e2e",
    chatGuid:    `iMessage;-;+${phone}`,
    chatId:      CHAT[phone],
    contact:     `+${phone}`,
    contactName: phone === SECOND_PHONE ? "Second User" : "Test User",
    draftText:   over.draftText || "Sounds good, see you at 7!",
    arrivedAt:   new Date(Date.now() - 60_000).toISOString(),
    postedAt:    new Date().toISOString(),
  };
  ghost.savePendingDrafts([...ghost.loadPendingDrafts(), draft]);
  return draft;
}

// ─── Serve ──────────────────────────────────────────────────────────────────
const startup = {};

beforeAll(async () => {
  // A draft left pending by a previous process: its approval card died with that process.
  ghost.savePendingDrafts([{
    draftId: "e2e-orphan-001", chatGuid: `iMessage;-;+${ALLOWED_PHONE}`, chatId: 1,
    contact: `+${ALLOWED_PHONE}`, contactName: "Test User", draftText: "left over",
    arrivedAt: new Date().toISOString(), postedAt: new Date().toISOString(),
  }]);
  ghost.cmdServe();
  await until(() => global.__imsgRpcLog.some(r => r.method === "watch.subscribe"), 5000, "watch.subscribe");
  await until(() => global.__imsgState.watchProc !== null, 5000, "subscribe reply");
  startup.drafts   = ghost.loadPendingDrafts();
  startup.feedback = readFeedback();
  startup.spawns   = global.__imsgSpawns.map(a => [...a]);
  startup.rpc      = global.__imsgRpcLog.map(r => ({ ...r }));
  startup.sends    = global.__ghostSendLog.length;
});

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

// ─── Per-test reset ─────────────────────────────────────────────────────────
function clearState() {
  global.__ghostDiscordLog   = [];
  global.__ghostSendLog      = [];
  global.__ghostApprovals    = [];
  global.__imsgRpcLog        = [];
  global.__imsgState.history = {};
  global.__ghostSendReply    = null;
  global.__ghostApprovalFail = false;
  for (const e of ghost.pendingMessages.values()) clearTimeout(e.timeoutId);
  ghost.pendingMessages.clear();
  ghost.pendingUnknownAlerts.clear();
  ghost.unknownAlertCounts.clear();
  if (ghost.kleinRepliedRecentlyChats) ghost.kleinRepliedRecentlyChats.clear();
  ghost.cancelledDraftIds.clear();
  ghost.cancelledDraftTtl.clear();
  if (ghost.sendLocks) ghost.sendLocks.clear();
  global.__ghostORResponse   = { choices: [{ message: { content: "That works for me." } }] };

  for (const f of [
    "ghost-pending-drafts.json", "ghost-feedback.json", "ghost-conv-state.json",
    "ghost-denylist.json", "ghost-spam-log.json", "ghost-spam-ratelimit.json",
    "ghost-outbound-rate.json", "ghost-outbound-backoff.json", "ghost-event-dedup.json",
  ]) { try { fs.unlinkSync(path.join(dataDir, f)); } catch {} }
}

beforeEach(() => {
  clearState();
  setupNock();
  // Pin the clock to 2pm local so the quiet-hours gate doesn't make these flows depend on
  // when the suite runs. Real timers stay real.
  const twopm = new Date();
  twopm.setHours(14, 0, 0, 0);
  jest.useFakeTimers({
    now: twopm.getTime(),
    doNotFake: ["nextTick", "setImmediate", "Promise", "setTimeout", "setInterval", "clearTimeout", "clearInterval"],
  });
});

afterEach(() => {
  jest.useRealTimers();
  nock.cleanAll();
});

const KEY = `iMessage;-;+${ALLOWED_PHONE}`;

/** Inbound message → queued → checkAndDraft → the draft's approval request is open. */
async function draftToApproval(text = "Hey, are you free this weekend?") {
  pushInbound(rawMsg({ text }));
  await until(() => ghost.pendingMessages.has(KEY), 5000, "draft queued");
  const run = ghost.checkAndDraft(KEY);
  const approval = await nextApproval();
  return { run, approval };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  E2E FLOW 1 — Startup
// ═══════════════════════════════════════════════════════════════════════════════
describe("E2E Flow 1: serve startup", () => {
  test("serve_subscribes_over_imsg_rpc: wrapper argv is exactly [rpc], subscribe is JSON-RPC 2.0 on stdin", () => {
    expect(startup.spawns).toEqual([["rpc"]]);
    const sub = startup.rpc.find(r => r.method === "watch.subscribe");
    expect(sub).toMatchObject({ jsonrpc: "2.0", method: "watch.subscribe", params: { include_reactions: true, attachments: false } });
    expect(sub.params).not.toHaveProperty("since_rowid"); // fresh cursor
  });

  test("serve_expires_orphaned_drafts: a draft pending at startup expires unsent", () => {
    expect(startup.drafts).toHaveLength(0);
    expect(startup.feedback.some(e => e.draftId === "e2e-orphan-001" && e.decision === "expired-restart")).toBe(true);
    expect(startup.sends).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  E2E FLOW 2 — Reactions and groups (the "no reply" invariants)
// ═══════════════════════════════════════════════════════════════════════════════
describe("E2E Flow 2: reactions and groups", () => {
  test("reaction_event: is_reaction payload → no draft, no approval, no send", async () => {
    pushInbound(rawMsg({ text: 'Liked "Hey, are you free?"', isReaction: true }));
    await settle();
    expect(ghost.pendingMessages.size).toBe(0);
    expect(global.__ghostApprovals).toHaveLength(0);
    expect(global.__ghostDiscordLog).toHaveLength(0);
    expect(global.__ghostSendLog).toHaveLength(0);
  }, 10_000);

  test("emoji_only: 👍👍 → no draft", async () => {
    pushInbound(rawMsg({ text: "👍👍" }));
    await settle();
    expect(ghost.pendingMessages.size).toBe(0);
  }, 10_000);

  test("group_chat: is_group payload → no draft, no approval", async () => {
    pushInbound(rawMsg({ text: "who's coming saturday?", isGroup: true }));
    await settle();
    expect(ghost.pendingMessages.size).toBe(0);
    expect(global.__ghostApprovals).toHaveLength(0);
  }, 10_000);

  test("cursor_saved: each received rowid becomes the resume point", async () => {
    const m = rawMsg({ text: "👍" });
    pushInbound(m);
    await settle(50);
    const cursor = JSON.parse(fs.readFileSync(ghost.IMSG_CURSOR_FILE, "utf8"));
    expect(cursor.sinceRowid).toBe(m.id);
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  E2E FLOW 3 — Message → draft → approval → native send
// ═══════════════════════════════════════════════════════════════════════════════
describe("E2E Flow 3: draft lifecycle through the native approval", () => {
  test("allow_once_sends: exact approval params, then exact native send argv", async () => {
    const { run, approval } = await draftToApproval();

    // context and collision reads went over imsg rpc by chat id
    expect(global.__imsgRpcLog.some(r => r.method === "messages.history" && r.params.chat_id === 1)).toBe(true);

    expect(approval.args.slice(0, 4)).toEqual(["gateway", "call", "plugin.approval.request", "--json"]);
    expect(approval.params).toMatchObject({
      pluginId: "ghost-pipeline",
      description: "That works for me.",
      allowedDecisions: ["allow-once", "deny"],
      agentId: "ghost",
      sessionKey: `agent:ghost:discord:channel:${CHANNEL}`,
      turnSourceChannel: "discord",
      turnSourceTo: `channel:${CHANNEL}`,
    });
    expect(approval.params.title).toContain(`+${ALLOWED_PHONE}`);
    expect(approval.params.title.length).toBeLessThanOrEqual(80);
    expect(approval.params.timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect(approval.params.timeoutMs).toBeLessThanOrEqual(600_000);

    // draft is posted, nothing sent before the decision
    expect(global.__ghostDiscordLog.length).toBeGreaterThan(0);
    expect(ghost.loadPendingDrafts()).toHaveLength(1);
    expect(global.__ghostSendLog).toHaveLength(0);

    answer(approval, "allow-once");
    await run;

    expect(global.__ghostSendLog).toHaveLength(1);
    expect(global.__ghostSendLog[0].args).toEqual(
      ["message", "send", "--channel", "imessage", "--target", `+${ALLOWED_PHONE}`, "--message", "That works for me.", "--json"]
    );
    expect(ghost.loadPendingDrafts()).toHaveLength(0);
    expect(readFeedback().some(e => e.decision === "sent")).toBe(true);
    // the wrapper never carried message data in argv
    expect(global.__imsgSpawns.every(a => a.length === 1 && a[0] === "rpc")).toBe(true);
  }, 15_000);

  test("deny: Deny on the card → no send, Discord cancel notice", async () => {
    const { run, approval } = await draftToApproval();
    global.__ghostDiscordLog = [];
    answer(approval, "deny");
    await run;
    expect(global.__ghostSendLog).toHaveLength(0);
    expect(ghost.loadPendingDrafts()).toHaveLength(0);
    expect(global.__ghostDiscordLog.length).toBeGreaterThan(0);
    expect(readFeedback().some(e => e.decision === "cancelled")).toBe(true);
  }, 15_000);

  test("expiry: decision null → expired unsent (AUTOSEND-FAILCLOSED)", async () => {
    const { run, approval } = await draftToApproval();
    answer(approval, null);
    await run;
    expect(global.__ghostSendLog).toHaveLength(0);
    expect(ghost.loadPendingDrafts()).toHaveLength(0);
    expect(readFeedback().some(e => e.decision === "expired")).toBe(true);
  }, 15_000);

  test("approval_transport_failure: gateway call fails → expired unsent", async () => {
    global.__ghostApprovalFail = true;
    pushInbound(rawMsg());
    await until(() => ghost.pendingMessages.has(KEY), 5000, "draft queued");
    await ghost.checkAndDraft(KEY);
    expect(global.__ghostSendLog).toHaveLength(0);
    expect(ghost.loadPendingDrafts()).toHaveLength(0);
    expect(readFeedback().some(e => e.decision === "expired")).toBe(true);
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  E2E FLOW 4 — Klein replies by hand
// ═══════════════════════════════════════════════════════════════════════════════
describe("E2E Flow 4: Klein replies (is_from_me)", () => {
  test("during_debounce: is_from_me row cancels the queued draft", async () => {
    pushInbound(rawMsg({ text: "Hey, are you there?" }));
    await until(() => ghost.pendingMessages.has(KEY), 5000, "draft queued");
    pushInbound(rawMsg({ text: "Yeah I'm here!", isFromMe: true }));
    await until(() => !ghost.pendingMessages.has(KEY), 5000, "queued draft cancelled");
    expect(global.__ghostApprovals).toHaveLength(0);
    expect(global.__ghostSendLog).toHaveLength(0);
  }, 15_000);

  test("after_card_posted: Klein's reply cancels the draft; a later Allow Once sends nothing", async () => {
    const { run, approval } = await draftToApproval();
    pushInbound(rawMsg({ text: "omw", isFromMe: true }));
    await until(() => ghost.loadPendingDrafts().length === 0, 5000, "posted draft cancelled");
    answer(approval, "allow-once");
    await run;
    expect(global.__ghostSendLog).toHaveLength(0);
  }, 15_000);

  test("collision_at_draft_time: Klein's reply in the thread history → no draft, no card", async () => {
    pushInbound(rawMsg({ text: "Hey, are you around this afternoon?" }));
    await until(() => ghost.pendingMessages.has(KEY), 5000, "draft queued");
    global.__imsgState.history[1] = [{
      id: 9001, chat_id: 1, is_from_me: true, text: "Nothing much!",
      created_at: new Date(Date.now() + 5000).toISOString(),
    }];
    await ghost.checkAndDraft(KEY);
    await settle(100);
    expect(global.__ghostApprovals).toHaveLength(0);
    expect(ghost.loadPendingDrafts()).toHaveLength(0);
    expect(global.__ghostSendLog).toHaveLength(0);
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  E2E FLOW 5 — Unknown number
// ═══════════════════════════════════════════════════════════════════════════════
describe("E2E Flow 5: unknown number", () => {
  test("unknown_deny: approval card for the number; Deny → denylisted, no draft", async () => {
    pushInbound(rawMsg({ phone: UNKNOWN_PHONE, text: "Hi, is this Klein? It's Jordan from the lab" }));
    const approval = await nextApproval();
    expect(approval.params.title).toContain(`+${UNKNOWN_PHONE}`);
    expect(approval.params.description).toContain("Jordan from the lab");
    expect(approval.params.timeoutMs).toBe(600_000);
    expect(ghost.isAllowed(UNKNOWN_PHONE)).toBe(false);

    answer(approval, "deny");
    await until(() => ghost.isDenied(UNKNOWN_PHONE), 5000, "denylisted");
    expect(ghost.pendingMessages.size).toBe(0);
    expect(global.__ghostSendLog).toHaveLength(0);
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  E2E FLOW 6 — Security gates
// ═══════════════════════════════════════════════════════════════════════════════
describe("E2E Flow 6: security gates", () => {
  test("drift_marker: an approved draft with internal pipeline text never reaches the wire", async () => {
    const d = seedDraft({ draftText: "[KleinClaw-Ghost] Read: lines 1-50 from SOUL.md" });
    // "handled" means the draft left the pending file; a gate block is handled, not sent.
    const r = await ghost.resolveDraftDecision(d.draftId, "allow-once", d.draftText);
    expect(r.action).toBe("handled");
    expect(global.__ghostSendLog).toHaveLength(0);
    expect(readFeedback().some(e => e.decision === "blocked-internal-marker")).toBe(true);
  }, 10_000);

  test("rate_limit: second approved send to the same contact → blocked, Discord notified", async () => {
    const d1 = seedDraft({ phone: SECOND_PHONE, draftText: "Sure, sounds good!" });
    expect((await ghost.resolveDraftDecision(d1.draftId, "allow-once", d1.draftText)).action).toBe("handled");
    expect(global.__ghostSendLog).toHaveLength(1);

    global.__ghostDiscordLog = [];
    const d2 = seedDraft({ phone: SECOND_PHONE, draftText: "Actually one more thing" });
    await ghost.resolveDraftDecision(d2.draftId, "allow-once", d2.draftText);
    expect(global.__ghostSendLog).toHaveLength(1);
    expect(global.__ghostDiscordLog.filter(d => d.method === "POST_OR_GET").length).toBeGreaterThan(0);
  }, 15_000);

  test("native_send_failure: channel error → one attempt, send-failed, owner told", async () => {
    global.__ghostSendReply = {
      err: Object.assign(new Error("exit 1"), { code: 1 }),
      stdout: JSON.stringify({ ok: false, error: { type: "ChannelError", message: "imessage channel is disabled" } }),
    };
    const d = seedDraft();
    const r = await ghost.resolveDraftDecision(d.draftId, "allow-once", d.draftText);
    expect(r.action).toBe("send_failed");
    expect(global.__ghostSendLog).toHaveLength(1);
    expect(readFeedback().some(e => e.decision === "send-failed")).toBe(true);
    expect(global.__ghostDiscordLog.length).toBeGreaterThan(0);
    expect(ghost.loadPendingDrafts()).toHaveLength(0);
  }, 10_000);
});
