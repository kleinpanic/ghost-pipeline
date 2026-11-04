"use strict";

/**
 * auditFixes.test.js — regression tests for the security/correctness audit fixes.
 *
 *   1. addToDenylist removed allowlist lines by substring ("+<n>"): a short code wiped
 *      matching contacts, an empty number wiped every contact.
 *   2. addToAllowlist wrote the caller-supplied name verbatim — newlines injected extra
 *      allowlist entries into CONTACTS.md.
 *   3. bbSendMessage only allowlist-checked guids matching a fixed service list, so email
 *      handles / "any;-;" guids skipped the check; executeSend never checked that the chat
 *      belonged to the contact the draft was written for. (NAT-25: the chokepoint is now
 *      sendIMessage and takes an E.164 handle only.)
 *   4. HTTP API: control endpoints were unauthenticated on 0.0.0.0, the webhook had no
 *      shared-secret option, and request bodies were unbounded. (NAT-25: every state-
 *      changing route is gone; /pending stays loopback-or-token.)
 *   5. doReactionCheck overwrote the drafts file with its start-of-run snapshot, dropping
 *      drafts posted mid-run and resurrecting drafts removed mid-run.
 *   6. Discord bot token was passed to curl in argv (visible in `ps`).
 *   7. (learn) superseded on merge: local main had already moved learn to Spark with
 *      fail-loud generation (D6/O-2); see learnFailLoud.test.js and learnTruncation.test.js.
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const http = require("http");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-audit-"));
process.env.HOME            = tmpHome;
// Local main gates every send behind the 90-03 fail-closed toggle; these tests exercise
// the routing checks behind it.
process.env.GHOST_SEND_ENABLED = "1";
process.env.GHOST_API_TOKEN = "test-api-token-123";

const ghostWsDir    = path.join(tmpHome, ".openclaw", "workspace-ghost");
const dataDir       = path.join(tmpHome, ".openclaw", "data");
const CONTACTS_FILE = path.join(ghostWsDir, "governance", "CONTACTS.md");
fs.mkdirSync(path.join(ghostWsDir, "governance"), { recursive: true });
fs.mkdirSync(path.join(ghostWsDir, "memory", "contacts"), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".config", "discord"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".config", "openrouter"), { recursive: true });
fs.writeFileSync(path.join(tmpHome, ".config", "discord", "bot-token"), "SECRET.discord.token");
fs.writeFileSync(path.join(tmpHome, ".config", "openrouter", "api-key"), "test-or-key");

const PHONE_A = "15551234567";
const PHONE_B = "15557654321";
const PHONE_C = "12345678901"; // starts with the short code 12345

function writeContacts() {
  fs.writeFileSync(CONTACTS_FILE, [
    "# Contacts",
    "<!-- CONTACT_ALLOWLIST_START -->",
    `- Alice | +${PHONE_A} | ask | friend | Alice`,
    `- Bob | +${PHONE_B} | ask | friend | Bob`,
    `- Carol | +${PHONE_C} | ask | friend | Carol`,
    "<!-- CONTACT_ALLOWLIST_END -->",
  ].join("\n") + "\n");
}

// ─── child_process mock: record every spawn, script per-command behaviour ────
jest.mock("child_process", () => {
  const { EventEmitter } = require("events");
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    spawnSync: jest.fn(() => ({ status: 1, stdout: "", stderr: "mocked" })),
    spawn: jest.fn((cmd, args) => {
      const call  = { cmd, args: [...args], stdin: "" };
      (global.__spawns = global.__spawns || []).push(call);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin  = { write: s => { call.stdin += s; }, end: () => {} };
      child.kill   = () => {};
      const handler = (global.__spawnHandlers || {})[cmd];
      const { stdout = "{}", code = 0 } = handler ? handler(args, call) || {} : {};
      process.nextTick(() => {
        child.stdout.emit("data", typeof stdout === "string" ? stdout : JSON.stringify(stdout));
        child.emit("close", code);
      });
      return child;
    }),
  };
});

const nock = require("nock");
nock.disableNetConnect();
nock.enableNetConnect("127.0.0.1");

const ghost = require("../../src/ghost");

const spawns    = () => global.__spawns || [];
const wireSends = [];
ghost.setTransport({
  sendIMessage: async (target, text) => { wireSends.push({ target, text }); return { ok: true }; },
  imsgRequest:  async () => ({ messages: [] }),
});

beforeEach(() => {
  writeContacts();
  for (const f of fs.readdirSync(dataDir)) fs.rmSync(path.join(dataDir, f), { force: true });
  global.__spawns = [];
  wireSends.length = 0;
  global.__spawnHandlers = {
    curl: () => ({ stdout: { id: "discord-msg-1" } }),
  };
  ghost.kleinRepliedRecentlyChats.clear();
  ghost.cancelledDraftIds.clear();
  // Daytime, so quiet hours never interfere
  const twopm = new Date(); twopm.setHours(14, 0, 0, 0);
  jest.useFakeTimers({
    now: twopm.getTime(),
    doNotFake: ["nextTick", "setImmediate", "Promise", "setTimeout", "setInterval", "clearTimeout", "clearInterval"],
  });
});

afterEach(() => {
  jest.useRealTimers();
  nock.cleanAll();
});

afterAll(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

// ─── 1. Denylist removal ─────────────────────────────────────────────────────
describe("addToDenylist removes only the exact contact", () => {
  test("denying short code 12345 keeps +12345678901 on the allowlist", () => {
    ghost.addToDenylist("12345");
    expect(ghost.isAllowed(`+${PHONE_C}`)).toBe(true);
    expect(ghost.loadAllowlist()).toHaveLength(3);
  });

  test("a non-numeric phone is rejected and does not wipe the allowlist", () => {
    expect(() => ghost.addToDenylist("not-a-number")).toThrow(/invalid phone/);
    expect(ghost.loadAllowlist()).toHaveLength(3);
  });

  test("denying an allowlisted number removes just that entry", () => {
    ghost.addToDenylist(`+${PHONE_A}`);
    expect(ghost.isAllowed(PHONE_A)).toBe(false);
    expect(ghost.isDenied(PHONE_A)).toBe(true);
    expect(ghost.loadAllowlist().map(c => c.phone).sort()).toEqual([PHONE_C, PHONE_B].sort());
  });
});

// ─── 2. Allowlist line injection ─────────────────────────────────────────────
describe("addToAllowlist sanitizes free-text fields", () => {
  test("a newline in the name cannot inject another allowlist entry", () => {
    ghost.addToAllowlist("+15550001111", "Mallory\n- Evil | +15559990000 | ask | close_friend | Evil");
    expect(ghost.isAllowed("+15550001111")).toBe(true);
    expect(ghost.isAllowed("+15559990000")).toBe(false);
    const added = ghost.loadAllowlist().find(c => c.phone === "15550001111");
    expect(added.name).not.toMatch(/[\n|]/);
  });

  test("an HTML comment marker in the name cannot close the allowlist block", () => {
    ghost.addToAllowlist("+15550002222", "x <!-- CONTACT_ALLOWLIST_END --> y");
    const raw = fs.readFileSync(CONTACTS_FILE, "utf8");
    expect(raw.match(/CONTACT_ALLOWLIST_END/g)).toHaveLength(1);
    expect(ghost.isAllowed("+15550002222")).toBe(true);
  });

  test("a nested marker cannot reassemble after stripping", () => {
    ghost.addToAllowlist("+15550002223", "CONTACT_ALLOWLIST_CONTACT_ALLOWLIST_ENDEND <!<!---->-- y");
    ghost.addToAllowlist("+15550002224", "Later");
    const raw = fs.readFileSync(CONTACTS_FILE, "utf8");
    expect(raw.match(/CONTACT_ALLOWLIST_END/g)).toHaveLength(1);
    expect(raw.match(/<!--/g)).toHaveLength(2);
    expect(ghost.isAllowed("+15550002223")).toBe(true);
    expect(ghost.isAllowed("+15550002224")).toBe(true);
  });

  test("an empty phone is rejected", () => {
    expect(() => ghost.addToAllowlist("", "Nobody")).toThrow(/invalid phone/);
  });
});

// ─── 3. Recipient checks on send ─────────────────────────────────────────────
describe("send path only delivers to the allowlisted 1:1 chat of the draft's contact", () => {
  test("dmPhoneFromChatGuid only accepts 1:1 phone guids", () => {
    expect(ghost.dmPhoneFromChatGuid(`iMessage;-;+${PHONE_A}`)).toBe(`+${PHONE_A}`);
    expect(ghost.dmPhoneFromChatGuid(`any;-;+${PHONE_A}`)).toBe(`+${PHONE_A}`);
    expect(ghost.dmPhoneFromChatGuid("iMessage;-;someone@example.com")).toBeNull();
    expect(ghost.dmPhoneFromChatGuid("iMessage;+;chat123")).toBeNull();
    expect(ghost.dmPhoneFromChatGuid(PHONE_A)).toBeNull();
  });

  test.each([
    ["email handle", "attacker@example.com"],
    ["non-allowlisted number", "+15550009999"],
    ["group chat guid", "iMessage;+;chat999"],
    ["allowlisted number as a guid", `any;-;+${PHONE_A}`],
  ])("sendIMessage refuses %s", async (_label, target) => {
    expect(await ghost.sendIMessage(target, "hello")).toBe(false);
    expect(wireSends).toHaveLength(0);
  });

  test("sendIMessage still sends to an allowlisted E.164 handle", async () => {
    expect(await ghost.sendIMessage(`+${PHONE_A}`, "hello")).toBe(true);
    expect(wireSends).toEqual([{ target: `+${PHONE_A}`, text: "hello" }]);
  });

  test("executeSend blocks a draft whose chat belongs to a different contact", async () => {
    const draft = {
      draftId: "mismatch1", contact: PHONE_A, contactName: "Alice",
      chatGuid: `iMessage;-;+${PHONE_B}`, draftText: "yo",
      arrivedAt: new Date(Date.now() - 60_000).toISOString(), postedAt: new Date().toISOString(),
    };
    expect(await ghost.executeSend(draft, "approval:allow-once")).toBe(true);
    expect(wireSends).toHaveLength(0);
  });
});

// ─── 4. HTTP API auth + body limit ───────────────────────────────────────────
describe("HTTP API authorization", () => {
  const TOKEN = "test-api-token-123";
  const fakeReq = (remoteAddress, { headers = {}, url = "/" } = {}) => ({ socket: { remoteAddress }, headers, url });

  test("control endpoints: loopback allowed, remote needs the token", () => {
    expect(ghost.isAuthorizedRequest(fakeReq("127.0.0.1"), "control", TOKEN)).toBe(true);
    expect(ghost.isAuthorizedRequest(fakeReq("::ffff:127.0.0.1"), "control", TOKEN)).toBe(true);
    expect(ghost.isAuthorizedRequest(fakeReq("10.0.0.50"), "control", TOKEN)).toBe(false);
    expect(ghost.isAuthorizedRequest(fakeReq("10.0.0.50"), "control", "")).toBe(false);
    expect(ghost.isAuthorizedRequest(fakeReq("10.0.0.50", { headers: { authorization: `Bearer ${TOKEN}` } }), "control", TOKEN)).toBe(true);
    expect(ghost.isAuthorizedRequest(fakeReq("10.0.0.50", { headers: { "x-ghost-token": TOKEN } }), "control", TOKEN)).toBe(true);
    expect(ghost.isAuthorizedRequest(fakeReq("10.0.0.50", { headers: { "x-ghost-token": "wrong" } }), "control", TOKEN)).toBe(false);
  });

  describe("over a real socket", () => {
    let server, port;
    beforeAll(done => {
      server = ghost.createServer();
      server.listen(0, "127.0.0.1", () => { port = server.address().port; done(); });
    });
    afterAll(done => { server.close(done); });

    const post = (urlPath, body) => new Promise((resolve, reject) => {
      const data = typeof body === "string" ? body : JSON.stringify(body);
      const req = http.request({
        hostname: "127.0.0.1", port, path: urlPath, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      }, res => {
        let out = "";
        res.on("data", c => { out += c; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(out || "{}") }));
      });
      req.on("error", reject);
      req.end(data);
    });

    const get = (urlPath) => new Promise((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: urlPath }, res => {
        let out = "";
        res.on("data", c => { out += c; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(out || "{}") }));
      }).on("error", reject);
    });

    // NAT-25: these routes were the unauthenticated or weakly authenticated control
    // surface (approve-contact had no auth; /action trusted a public Discord user id).
    test.each(["/bluebubbles/message-sent", "/action", "/approve-contact", "/deny-contact"])(
      "removed state-changing route %s answers 404 and changes nothing", async (route) => {
        const r = await post(route, { phone: "+15550003333", name: "Zed", draftId: "x", action: "send", userId: "1" });
        expect(r.status).toBe(404);
        expect(ghost.isAllowed("+15550003333")).toBe(false);
        expect(wireSends).toHaveLength(0);
      });

    test("/health and loopback /pending still answer", async () => {
      const h = await get("/health");
      expect(h.status).toBe(200);
      expect(h.body.transport).toBe("imessage-native");
      const p = await get("/pending");
      expect(p.status).toBe(200);
      expect(Array.isArray(p.body.awaitingApproval)).toBe(true);
    });
  });
});

// 5. (doReactionCheck save race) dropped on merge: its scenario needs a timer auto-send,
// which local main forbids (90-03 AUTOSEND-FAILCLOSED). The merge logic itself is kept.

// ─── 6. Discord token not in argv ────────────────────────────────────────────
describe("discordPost", () => {
  test("passes the bot token via stdin config, not argv, and disables mentions", async () => {
    await ghost.discordPost("chan1", { content: "@everyone hi" });
    const call = spawns().find(c => c.cmd === "curl");
    expect(call.args.join(" ")).not.toContain("SECRET.discord.token");
    expect(call.args).toContain("--config");
    expect(call.stdin).toContain('header = "Authorization: Bot SECRET.discord.token"');
    const payload = JSON.parse(call.args[call.args.indexOf("-d") + 1]);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });
});
