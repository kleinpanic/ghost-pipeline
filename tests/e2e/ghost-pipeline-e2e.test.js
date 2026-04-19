"use strict";

/**
 * ghost-pipeline-e2e.test.js — Ghost Pipeline End-to-End Tests
 *
 * Runs the full BlueBubbles webhook → ghost pipeline flow with mocked BB + Discord.
 * Verifies the critical "no reaction reply" invariant alongside draft lifecycle.
 *
 * Usage:
 *   npm run e2e        ← FORCE=1 repo-scope-guard + jest --runInBand
 *
 * Flows covered:
 *   1. Reaction event  → no draft, no Discord post, no BB send
 *   2. Normal message → draft generated, posted to Discord
 *   3. Draft → Cancel → draft removed from pending, Discord cancel posted
 *   4. Draft → Send   → BB MCP called, Discord confirmation posted
 *   5. Klein outgoing → in-memory pending draft cancelled
 *   6. Klein replies before auto-send → draft auto-cancelled
 *   7. doReactionCheck auto-sends stale draft
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const http = require("http");

// ─── Repo scope guard ────────────────────────────────────────────────────────
const REPO = __dirname + "/../..";
if (process.env.FORCE !== "1") {
  const { execSync } = require("child_process");
  try {
    const result = execSync(
      `${REPO}/../../../.openclaw/hooks/repo-scope-guard.sh dev "${REPO}"`,
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
process.env.HOME                = tmpHome;
process.env.BB_HOST            = "127.0.0.1";
process.env.BB_PORT            = "19234";
process.env.KLEIN_DISCORD_USER_ID = "KLEIN_USER_123";

const ghostWsDir = path.join(tmpHome, ".openclaw", "workspace-ghost");
const dataDir     = path.join(tmpHome, ".openclaw", "data");

fs.mkdirSync(path.join(ghostWsDir, "governance"), { recursive: true });
fs.mkdirSync(path.join(ghostWsDir, "memory", "contacts"), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".config", "openrouter"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".config", "discord"),    { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".openclaw"),             { recursive: true });
fs.writeFileSync(path.join(tmpHome, ".config", "openrouter", "api-key"), "test-key");
fs.writeFileSync(path.join(tmpHome, ".config", "discord",    "bot-token"), "test-token");
fs.writeFileSync(path.join(tmpHome, ".openclaw", ".gateway-token"), "test-gateway-token");

const ALLOWED_PHONE  = "15551234567";
const SECOND_PHONE   = "15552222222";

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

// ─── Mock log arrays (populated by spawn mock) ──────────────────────────────
global.__ghostSpawnLog    = [];
global.__ghostBBLog       = [];
global.__ghostDiscordLog  = [];
global.__ghostMockMessages = {};

// ─── Mock child_process.spawn ──────────────────────────────────────────────
jest.mock("child_process", () => {
  const { EventEmitter } = require("events");
  const actual = jest.requireActual("child_process");

  const createChild = (stdoutData, exitCode = 0) => {
    const child  = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin  = { write: jest.fn(), end: jest.fn() };
    // Use setImmediate (NOT process.nextTick) so fake timers don't break the mock
    setImmediate(() => {
      child.stdout.emit("data", typeof stdoutData === "string" ? stdoutData : JSON.stringify(stdoutData));
      child.emit("close", exitCode);
    });
    return child;
  };

  const discordMsgResponse = () => ({
    id: `msg-${Date.now()}`,
    components: [{
      type: 17,
      components: [{
        type: 1,
        components: [
          { type: 2, custom_id: "occomp:cid=shortId1", label: "✅ Send Now", style: 3 },
          { type: 2, custom_id: "occomp:cid=shortId2", label: "❌ Cancel",   style: 4 },
        ],
      }],
    }],
  });

  return {
    ...actual,
    spawn: jest.fn((cmd, args) => {
      global.__ghostSpawnLog.push({ cmd, args: [...(args || [])] });

      if (cmd === "curl") {
        const isDelete = args.includes("DELETE");
        const urlArg   = args.find(a => typeof a === "string" && a.includes("discord.com"));
        global.__ghostDiscordLog.push({ method: isDelete ? "DELETE" : "POST_OR_GET", url: urlArg });
        if (isDelete) return createChild("");
        return createChild(discordMsgResponse());
      }

      if (cmd === "mcporter") {
        const callIdx     = args.indexOf("call");
        const tool        = callIdx !== -1 ? (args[callIdx + 1] || "") : "";
        const argsJsonIdx = args.indexOf("--args");
        let toolArgs = {};
        if (argsJsonIdx !== -1) {
          try { toolArgs = JSON.parse(args[argsJsonIdx + 1]); } catch {}
        }

        if (tool === "bluebubbles.bb_get_chat_messages") {
          return createChild({ messages: global.__ghostMockMessages[toolArgs.chat_guid] || [] });
        }
        if (tool === "bluebubbles.bb_send_message") {
          global.__ghostBBLog.push({ chat_guid: toolArgs.chat_guid, message: toolArgs.message });
          return createChild({ status: 200, message: "sent" });
        }
        if (tool === "bluebubbles.bb_contact_query") {
          return createChild({ data: [] });
        }
        if (tool === "bluebubbles.bb_list_chats") {
          return createChild({ chats: [] });
        }
        return createChild({});
      }

      if (cmd === "openclaw") {
        return createChild({ reply: "Sounds good!" });
      }

      return createChild("{}");
    }),
    spawnSync: actual.spawnSync,
  };
});

// ─── nock setup ─────────────────────────────────────────────────────────────
const nock = require("nock");

function setupNock(port) {
  nock.enableNetConnect(`127.0.0.1:${port}`);

  nock("https://127.0.0.1:18789")
    .persist()
    .post("/tools/invoke")
    .reply(200, (_uri, body) => {
      const parsed = typeof body === "string"
        ? (() => { try { return JSON.parse(body); } catch { return {}; } })()
        : (body || {});
      const tool = parsed.tool || "";
      if (tool === "sessions_list") {
        return {
          ok: true,
          result: {
            details: { sessions: [] },
            content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }],
          },
        };
      }
      if (tool === "message") {
        return {
          ok: true,
          result: {
            details: {
              ok: true,
              result: { messageId: "mock-msg-oc-123", channelId: "test-channel" },
              components: true,
            },
            content: [{
              type: "text",
              text: JSON.stringify({ ok: true, result: { messageId: "mock-msg-oc-123" }, components: true }),
            }],
          },
        };
      }
      return { ok: true, result: {} };
    });

  // OpenRouter: read from global override (set per-test) or fall back to the default
  // Using a dynamic reply avoids duplicate-interceptor conflicts between tests.
  global.__ghostORResponse = global.__ghostORResponse || {
    choices: [{ message: { content: "Sounds good, I'll be there!" } }],
  };
  nock("https://openrouter.ai")
    .post("/api/v1/chat/completions")
    .reply(200, () => global.__ghostORResponse);

  nock("https://generativelanguage.googleapis.com")
    .persist()
    .post(/embedContent/)
    .replyWithError("not-available");

  nock("http://127.0.0.1:19234")
    .persist()
    .get(/\/api\/v1\//)
    .reply(200, { status: 200, data: [] })
    .post(/\/api\/v1\//)
    .reply(200, { status: "200", message: "sent" });

  nock("http://127.0.0.1:18080")
    .persist()
    .get("/v1/models")
    .replyWithError("ECONNREFUSED");
}

// ─── Require ghost ──────────────────────────────────────────────────────────
const ghost = require("../../src/ghost");

// ─── HTTP helper ────────────────────────────────────────────────────────────
function httpPost(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function makeEvent({
  chatGuid   = `iMessage;-;+${ALLOWED_PHONE}`,
  contact    = null,
  text       = "Hey, are you free?",
  dateCreated = null,
  isFromMe   = false,
  type       = "new-message",
} = {}) {
  return {
    type,
    data: {
      isFromMe,
      chatGuid,
      handle: {
        address: contact || (() => {
          const m = chatGuid.match(/iMessage;-;(\+\d+)/);
          return m ? m[1] : `+${ALLOWED_PHONE}`;
        })(),
      },
      text,
      dateCreated: dateCreated ?? Date.now(),
    },
  };
}

// ─── Server ─────────────────────────────────────────────────────────────────
let server;
let serverPort;

beforeAll(async () => {
  await new Promise(resolve => {
    server = ghost.createServer();
    server.listen(0, "127.0.0.1", () => {
      serverPort = server.address().port;
      resolve();
    });
  });
  // setupNock(serverPort) is called in beforeEach (after nock.cleanAll) to avoid duplicate interceptors
});

afterAll(done => {
  server.close(done);
  nock.cleanAll();
  nock.enableNetConnect();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

// ─── Per-test reset ─────────────────────────────────────────────────────────
function clearState() {
  global.__ghostSpawnLog     = [];
  global.__ghostBBLog        = [];
  global.__ghostDiscordLog   = [];
  global.__ghostMockMessages = {};
  ghost.pendingMessages.clear();
  ghost.pendingUnknownAlerts.clear();
  // Clear Klein's recently-replied map so collision guards don't persist between tests
  if (ghost.kleinRepliedRecentlyChats) ghost.kleinRepliedRecentlyChats.clear();
  if (ghost.cancelledDraftIds) { ghost.cancelledDraftIds.clear(); ghost.cancelledDraftTtl.clear(); }
  // Reset OpenRouter response to default (tests may override via global.__ghostORResponse)
  global.__ghostORResponse   = { choices: [{ message: { content: "Sounds good, I'll be there!" } }] };

  const files = [
    "ghost-pending-drafts.json",
    "ghost-button-registry.json",
    "ghost-button-actions.json",
    "ghost-feedback.json",
    "ghost-conv-state.json",
    "ghost-denylist.json",
    "ghost-spam-log.json",
    "ghost-spam-ratelimit.json",
    "ghost-outbound-rate.json",
    "ghost-outbound-backoff.json",
    "ghost-pause.json",
  ];
  for (const f of files) { try { fs.unlinkSync(path.join(dataDir, f)); } catch {} }
}

beforeEach(() => {
  clearState();
  // Re-register nock interceptors for each test (nock.cleanAll runs in afterEach)
  setupNock(serverPort);
  jest.useRealTimers();
});

afterEach(() => {
  jest.useRealTimers();
  nock.cleanAll();
});

// ═══════════════════════════════════════════════════════════════════════════════
//  E2E FLOW 1 — Reaction event (the critical "no reply" invariant)
// ═══════════════════════════════════════════════════════════════════════════════
describe("E2E Flow 1: Reaction event — no reply", () => {
  test("reaction_event: standalone BB reaction type → reason=reaction_event, no draft, no Discord, no BB",
    async () => {
      const resp = await httpPost(serverPort, "/bluebubbles/message-sent", {
        type: "new-message",
        data: {
          isFromMe:   false,
          chatGuid:   `iMessage;-;+${ALLOWED_PHONE}`,
          handle:     { address: `+${ALLOWED_PHONE}` },
          text:       'liked "Hey, are you free?"',
          dateCreated: Date.now(),
          type:       "reaction",
          isReaction: true,
        },
      });

      expect(resp.status).toBe(200);
      expect(["reaction_event", "ignored"]).toContain(resp.body.action);
      expect(ghost.pendingMessages.size).toBe(0);
      expect(global.__ghostDiscordLog).toHaveLength(0);
      expect(global.__ghostBBLog).toHaveLength(0);
    },
    10_000
  );

  test("reaction_event: inline tapback text → no_reply_needed, no draft",
    async () => {
      const resp = await httpPost(serverPort, "/bluebubbles/message-sent",
        makeEvent({ text: `liked "Hey, are you free?"` })
      );
      expect(resp.status).toBe(200);
      expect(["reaction_event", "no_reply_needed", "ignored"]).toContain(resp.body.action);
      expect(ghost.pendingMessages.size).toBe(0);
    },
    10_000
  );

  test("reaction_event: emoji-only message → no_reply_needed, no draft",
    async () => {
      const resp = await httpPost(serverPort, "/bluebubbles/message-sent",
        makeEvent({ text: "👍👍" })
      );
      expect(resp.status).toBe(200);
      expect(["no_reply_needed", "ignored"]).toContain(resp.body.action);
      expect(ghost.pendingMessages.size).toBe(0);
    },
    10_000
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  E2E FLOW 2 — Normal message → draft lifecycle
// ═══════════════════════════════════════════════════════════════════════════════
describe("E2E Flow 2: Normal message → draft lifecycle", () => {
  test("normal_message: allowed contact → draft scheduled, checkAndDraft posts to Discord",
    async () => {
      const chatGuid = `iMessage;-;+${ALLOWED_PHONE}`;

      // Override the OpenRouter response via global (avoids nock duplicate-interceptor issue)
      // "Sounds good, I'll be there!" would fail content safety; use a safe response instead.
      global.__ghostORResponse = { choices: [{ message: { content: "That works for me." } }] };

      const resp = await httpPost(serverPort, "/bluebubbles/message-sent",
        makeEvent({ chatGuid, text: "Hey, are you free this weekend?" })
      );

      expect(resp.body.action).toBe("draft_scheduled");
      expect(ghost.pendingMessages.has(chatGuid)).toBe(true);

      // Trigger draft generation (bypasses the 30s debounce timer)
      await ghost.checkAndDraft(chatGuid);

      // Wait for async Discord post to complete
      await new Promise(r => setTimeout(r, 200));

      // Draft posted to Discord
      const discordCalls = global.__ghostDiscordLog.filter(d => d.method === "POST_OR_GET");
      expect(discordCalls.length).toBeGreaterThan(0);

      // Draft saved to pending-drafts.json
      const drafts = ghost.loadPendingDrafts();
      expect(drafts.length).toBeGreaterThan(0);
      expect(drafts[0].draftText).toBe("That works for me.");
      expect(drafts[0].contactName).toBe("Test User");
    },
    15_000
  );

  test("draft_cancel: POST /action cancel → draft removed, Discord notified, no BB send",
    async () => {
      const chatGuid = `iMessage;-;+${ALLOWED_PHONE}`;
      const draftId  = "e2e-cancel-001";

      ghost.savePendingDrafts([{
        draftId,
        messageId:   "discord-msg-e2e",
        chatGuid,
        contact:     `+${ALLOWED_PHONE}`,
        contactName: "Test User",
        draftText:   "Yeah, I'll be there around 7!",
        arrivedAt:   new Date().toISOString(),
        postedAt:    new Date().toISOString(),
      }]);

      const resp = await httpPost(serverPort, "/action", {
        draftId,
        action:  "cancel",
        userId:  "KLEIN_USER_123",
      });

      expect(resp.status).toBe(200);
      expect(resp.body.action).toBe("cancelled");
      expect(ghost.loadPendingDrafts().find(d => d.draftId === draftId)).toBeUndefined();
      expect(global.__ghostBBLog).toHaveLength(0);

      await new Promise(r => setTimeout(r, 100));
      expect(global.__ghostDiscordLog.length).toBeGreaterThan(0);
    },
    15_000
  );

  test("draft_send: POST /action send → BB MCP called with correct text, draft removed",
    async () => {
      const chatGuid  = `iMessage;-;+${ALLOWED_PHONE}`;
      const draftText = "Sounds good, see you at 7!";
      const draftId   = "e2e-send-001";

      ghost.savePendingDrafts([{
        draftId,
        messageId:   "discord-msg-e2e",
        chatGuid,
        contact:     `+${ALLOWED_PHONE}`,
        contactName: "Test User",
        draftText,
        arrivedAt:   new Date().toISOString(),
        postedAt:    new Date().toISOString(),
      }]);

      const resp = await httpPost(serverPort, "/action", {
        draftId,
        action: "send",
        userId: "KLEIN_USER_123",
      });

      expect(resp.status).toBe(200);
      expect(resp.body.action).toBe("sent");

      await new Promise(r => setTimeout(r, 200));

      // BB send called
      expect(global.__ghostBBLog).toHaveLength(1);
      expect(global.__ghostBBLog[0].chat_guid).toBe(chatGuid);
      expect(global.__ghostBBLog[0].message).toBe(draftText);

      // Draft removed from pending
      expect(ghost.loadPendingDrafts().find(d => d.draftId === draftId)).toBeUndefined();
    },
    15_000
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  E2E FLOW 3 — Klein outgoing → draft cancelled
// ═══════════════════════════════════════════════════════════════════════════════
describe("E2E Flow 3: Klein outgoing → draft cancelled", () => {
  test("klein_outgoing_during_debounce: Klein replies within 30s window → pending draft cancelled",
    async () => {
      const chatGuid = `iMessage;-;+${ALLOWED_PHONE}`;

      const resp1 = await httpPost(serverPort, "/bluebubbles/message-sent",
        makeEvent({ chatGuid, text: "Hey, are you there?" })
      );
      expect(resp1.body.action).toBe("draft_scheduled");
      expect(ghost.pendingMessages.has(chatGuid)).toBe(true);

      // Klein replies → cancels pending draft
      const resp2 = await httpPost(serverPort, "/bluebubbles/message-sent",
        makeEvent({ chatGuid, isFromMe: true, text: "Yeah I'm here!" })
      );

      expect(resp2.body.action).toBe("draft_cancelled");
      expect(ghost.pendingMessages.has(chatGuid)).toBe(false);
      expect(global.__ghostBBLog).toHaveLength(0);
    },
    15_000
  );

  test("klein_outgoing_after_posted_draft: Klein replies after draft posted → draft removed from JSON",
    async () => {
      const chatGuid = `iMessage;-;+${ALLOWED_PHONE}`;

      ghost.savePendingDrafts([{
        draftId:     "e2e-outgoing-cancel-001",
        chatGuid,
        contact:     `+${ALLOWED_PHONE}`,
        contactName: "Test User",
        draftText:   "I'll get back to you soon!",
        arrivedAt:   new Date(Date.now() - 60_000).toISOString(),
        postedAt:    new Date().toISOString(),
      }]);
      expect(ghost.loadPendingDrafts()).toHaveLength(1);

      const resp = await httpPost(serverPort, "/bluebubbles/message-sent",
        makeEvent({ chatGuid, isFromMe: true, text: "Sorry, can't talk right now" })
      );

      expect(resp.body.action).toBe("draft_cancelled");
      expect(ghost.loadPendingDrafts()).toHaveLength(0);
    },
    15_000
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  E2E FLOW 4 — Klein replies before auto-send
// ═══════════════════════════════════════════════════════════════════════════════
describe("E2E Flow 4: Klein replies before auto-send", () => {
  test("klein_replies_before_autosend: collision at checkAndDraft time → draft skipped",
    async () => {
      // Use SECOND_PHONE to avoid cross-test rate-limit contamination
      const chatGuid  = `iMessage;-;+${SECOND_PHONE}`;
      const arrivedAt = Date.now();

      const resp = await httpPost(serverPort, "/bluebubbles/message-sent",
        makeEvent({ chatGuid, text: "Hey, are you around this afternoon?" })
      );
      expect(resp.body.action).toBe("draft_scheduled");
      expect(ghost.pendingMessages.has(chatGuid)).toBe(true);

      // Klein replied after arrival (collision — draft should not send)
      global.__ghostMockMessages[chatGuid] = [
        { isFromMe: true, dateCreated: arrivedAt + 5000, text: "Nothing much!" },
      ];

      await ghost.checkAndDraft(chatGuid);
      await new Promise(r => setTimeout(r, 100));

      expect(ghost.loadPendingDrafts()).toHaveLength(0);
      expect(global.__ghostBBLog).toHaveLength(0);
    },
    15_000
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  E2E FLOW 5 — doReactionCheck auto-send
// ═══════════════════════════════════════════════════════════════════════════════
describe("E2E Flow 5: doReactionCheck auto-send", () => {
  test("autosend_fires: draft past cooldown → BB send triggered, draft removed",
    async () => {
      const chatGuid = `iMessage;-;+${ALLOWED_PHONE}`;

      ghost.savePendingDrafts([{
        draftId:     "e2e-autosend-001",
        messageId:   "discord-msg-autosend",
        chatGuid,
        contact:     `+${ALLOWED_PHONE}`,
        contactName: "Test User",
        draftText:   "I'll text you later!",
        arrivedAt:   new Date(Date.now() - 15 * 60_000).toISOString(),
        postedAt:    new Date(Date.now() - 10 * 60_000).toISOString(),
      }]);

      await ghost.doReactionCheck();
      await new Promise(r => setTimeout(r, 200));

      expect(global.__ghostBBLog).toHaveLength(1);
      expect(global.__ghostBBLog[0].chat_guid).toBe(chatGuid);
      expect(ghost.loadPendingDrafts()).toHaveLength(0);
    },
    15_000
  );

  test("autosend_skipped_when_cancelled: cancelled draft → doReactionCheck does not send",
    async () => {
      const chatGuid = `iMessage;-;+${ALLOWED_PHONE}`;
      const draftId  = "e2e-cancelled-autosend-001";

      ghost.savePendingDrafts([{
        draftId,
        messageId:   "discord-msg-cancelled",
        chatGuid,
        contact:     `+${ALLOWED_PHONE}`,
        contactName: "Test User",
        draftText:   "Never mind this draft!",
        arrivedAt:   new Date(Date.now() - 15 * 60_000).toISOString(),
        postedAt:    new Date(Date.now() - 10 * 60_000).toISOString(),
      }]);

      // Simulate what POST /action cancel does: populate cancelledDraftIds
      ghost.cancelledDraftIds.add(draftId);
      ghost.cancelledDraftTtl.set(draftId, Date.now() + 10 * 60_000);

      await ghost.doReactionCheck();
      await new Promise(r => setTimeout(r, 100));

      expect(global.__ghostBBLog).toHaveLength(0);
    },
    15_000
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  E2E FLOW 6 — Security gates: no internal leak, rate limit → Discord notify
// ═══════════════════════════════════════════════════════════════════════════════
describe("E2E Flow 6: Security gates", () => {
  test("e2e_drift_marker_blocked: draft with internal pipeline text never reaches BB",
    async () => {
      ghost.savePendingDrafts([{
        draftId:     "e2e-drift-001",
        chatGuid:    `iMessage;-;+${ALLOWED_PHONE}`,
        contact:     `+${ALLOWED_PHONE}`,
        contactName: "Test User",
        draftText:   "[KleinClaw-Ghost] Read: lines 1-50 from SOUL.md",
        arrivedAt:   new Date().toISOString(),
        postedAt:    new Date().toISOString(),
      }]);

      await httpPost(serverPort, "/action", { draftId: "e2e-drift-001", action: "send", userId: "KLEIN_USER_123" });
      await new Promise(r => setTimeout(r, 150));

      expect(global.__ghostBBLog).toHaveLength(0);
    },
    10_000
  );

  test("e2e_rate_limit_discord_notify: second send within 5min → BB blocked, Discord notified",
    async () => {
      const chatGuid  = `iMessage;-;+${SECOND_PHONE}`;

      // First send — should succeed
      ghost.savePendingDrafts([{
        draftId: "e2e-rate-001", chatGuid,
        contact: `+${SECOND_PHONE}`, contactName: "Second User",
        draftText: "Sure, sounds good!",
        arrivedAt: new Date().toISOString(), postedAt: new Date().toISOString(),
      }]);
      const r1 = await httpPost(serverPort, "/action", { draftId: "e2e-rate-001", action: "send", userId: "KLEIN_USER_123" });
      expect(r1.body.action).toBe("sent");
      await new Promise(r => setTimeout(r, 100));
      expect(global.__ghostBBLog).toHaveLength(1);

      // Immediate second send to same contact — must be rate-limited
      global.__ghostBBLog      = [];
      global.__ghostDiscordLog = [];
      ghost.savePendingDrafts([{
        draftId: "e2e-rate-002", chatGuid,
        contact: `+${SECOND_PHONE}`, contactName: "Second User",
        draftText: "Actually one more thing",
        arrivedAt: new Date().toISOString(), postedAt: new Date().toISOString(),
      }]);
      await httpPost(serverPort, "/action", { draftId: "e2e-rate-002", action: "send", userId: "KLEIN_USER_123" });
      await new Promise(r => setTimeout(r, 150));

      expect(global.__ghostBBLog).toHaveLength(0);
      // Discord must have received a block notification
      expect(global.__ghostDiscordLog.filter(d => d.method === "POST_OR_GET").length).toBeGreaterThan(0);
    },
    15_000
  );

  test("e2e_action_no_userid_rejected: /action without userId → 403, no BB send",
    async () => {
      ghost.savePendingDrafts([{
        draftId: "e2e-noauth-001",
        chatGuid: `iMessage;-;+${ALLOWED_PHONE}`,
        contact: `+${ALLOWED_PHONE}`, contactName: "Test User",
        draftText: "this should never send",
        arrivedAt: new Date().toISOString(), postedAt: new Date().toISOString(),
      }]);

      const resp = await httpPost(serverPort, "/action", { draftId: "e2e-noauth-001", action: "send" });
      expect(resp.status).toBe(403);
      await new Promise(r => setTimeout(r, 50));
      expect(global.__ghostBBLog).toHaveLength(0);
    },
    10_000
  );
});
