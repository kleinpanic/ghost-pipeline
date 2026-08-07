"use strict";

/**
 * sendToggleStyleGate.test.js — 90-03 additive chokepoint layers (RED→GREEN)
 *
 * Pins the two structural layers added INSIDE bbSendMessage (G10) per
 * 70-GHOST-RESEARCH §5b + GHOST-TOGGLE addendum and 90-RESEARCH AUTOSEND-FAILCLOSED:
 *
 *   Layer 1 — fail-closed master send toggle:
 *     absent / off / unparseable state ⇒ bbSendMessage returns false, ZERO wire
 *     calls, even for an otherwise-valid owner-allowlisted send.
 *     Enabled only by env GHOST_SEND_ENABLED=1|true or
 *     {"enabled": true} in data/ghost-send-enabled.json (re-read every send).
 *
 *   Layer 2 — positive style allowlist:
 *     outbound must LOOK like a casual human text. Structured/markdown/
 *     assistant-shaped text that PASSES the G3 drift denylist is still blocked.
 *
 *   Preservation — with both new layers passing, every pre-existing gate
 *     (drift denylist G3, recipient allowlist G2) still blocks as before.
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ─── Temp workspace (must precede require of ghost.js) ──────────────────────
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-toggle-"));
process.env.HOME    = tmpHome;
process.env.BB_HOST = "127.0.0.1";
process.env.BB_PORT = "19234";
delete process.env.GHOST_SEND_ENABLED; // fail-closed default under test

const ghostWsDir = path.join(tmpHome, ".openclaw", "workspace-ghost");
const dataDir    = path.join(tmpHome, ".openclaw", "data");
fs.mkdirSync(path.join(ghostWsDir, "governance"), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const ALLOWED_PHONE = "15551234567";
fs.writeFileSync(
  path.join(ghostWsDir, "governance", "CONTACTS.md"),
  [
    "# Test Contacts",
    "<!-- CONTACT_ALLOWLIST_START -->",
    `- Test User | +${ALLOWED_PHONE} | ask | friend | Test User`,
    "<!-- CONTACT_ALLOWLIST_END -->",
  ].join("\n") + "\n"
);

// ─── Mock child_process — capture every wire attempt ────────────────────────
global.__toggleSpawnLog = [];
global.__toggleBBLog    = [];

jest.mock("child_process", () => {
  const { EventEmitter } = require("events");
  const actual = jest.requireActual("child_process");

  const createChild = (stdoutData, exitCode = 0) => {
    const child  = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin  = { write: jest.fn(), end: jest.fn() };
    setImmediate(() => {
      child.stdout.emit("data", typeof stdoutData === "string" ? stdoutData : JSON.stringify(stdoutData));
      child.emit("close", exitCode);
    });
    return child;
  };

  return {
    ...actual,
    spawn: jest.fn((cmd, args) => {
      global.__toggleSpawnLog.push({ cmd, args: [...(args || [])] });
      if (cmd === "mcporter") {
        const callIdx     = args.indexOf("call");
        const tool        = callIdx !== -1 ? (args[callIdx + 1] || "") : "";
        const argsJsonIdx = args.indexOf("--args");
        let toolArgs = {};
        if (argsJsonIdx !== -1) {
          try { toolArgs = JSON.parse(args[argsJsonIdx + 1]); } catch {}
        }
        if (tool === "bluebubbles.bb_send_message") {
          global.__toggleBBLog.push({ chat_guid: toolArgs.chat_guid, message: toolArgs.message });
          return createChild({ status: 200, message: "sent" });
        }
        return createChild({});
      }
      return createChild("{}");
    }),
    spawnSync: actual.spawnSync,
  };
});

const ghost = require("../../src/ghost.js");

const TOGGLE_FILE = path.join(dataDir, "ghost-send-enabled.json");
const CHAT_GUID   = `iMessage;-;+${ALLOWED_PHONE}`;
const CASUAL_TEXT = "yeah for sure, running a bit late tho";

function wireCalls() {
  return global.__toggleBBLog.length;
}

beforeEach(() => {
  global.__toggleSpawnLog = [];
  global.__toggleBBLog    = [];
  delete process.env.GHOST_SEND_ENABLED;
  try { fs.unlinkSync(TOGGLE_FILE); } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════
//  Layer 1 — fail-closed toggle
// ═══════════════════════════════════════════════════════════════════════════
describe("fail-closed send toggle", () => {
  test("toggle_absent_blocks: no env, no state file → blocked, zero wire calls", async () => {
    const ok = await ghost.bbSendMessage(CHAT_GUID, CASUAL_TEXT);
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });

  test("toggle_file_disabled_blocks: {\"enabled\": false} → blocked", async () => {
    fs.writeFileSync(TOGGLE_FILE, JSON.stringify({ enabled: false }));
    const ok = await ghost.bbSendMessage(CHAT_GUID, CASUAL_TEXT);
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });

  test("toggle_file_corrupt_blocks: unparseable state file → blocked (fail-closed)", async () => {
    fs.writeFileSync(TOGGLE_FILE, "{not json!!");
    const ok = await ghost.bbSendMessage(CHAT_GUID, CASUAL_TEXT);
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });

  test("toggle_file_wrong_shape_blocks: {\"enabled\": \"yes\"} (non-boolean) → blocked", async () => {
    fs.writeFileSync(TOGGLE_FILE, JSON.stringify({ enabled: "yes" }));
    const ok = await ghost.bbSendMessage(CHAT_GUID, CASUAL_TEXT);
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });

  test("toggle_env_enables: GHOST_SEND_ENABLED=1 → send proceeds through gates to wire", async () => {
    process.env.GHOST_SEND_ENABLED = "1";
    const ok = await ghost.bbSendMessage(CHAT_GUID, CASUAL_TEXT);
    expect(ok).toBe(true);
    expect(wireCalls()).toBe(1);
    expect(global.__toggleBBLog[0].chat_guid).toBe(CHAT_GUID);
  });

  test("toggle_file_enables: {\"enabled\": true} → send proceeds (runtime, no restart)", async () => {
    fs.writeFileSync(TOGGLE_FILE, JSON.stringify({ enabled: true }));
    const ok = await ghost.bbSendMessage(CHAT_GUID, CASUAL_TEXT);
    expect(ok).toBe(true);
    expect(wireCalls()).toBe(1);
  });

  test("toggle_state_queryable: ghostSendToggleState reports enabled + source", () => {
    expect(ghost.ghostSendToggleState().enabled).toBe(false);
    fs.writeFileSync(TOGGLE_FILE, JSON.stringify({ enabled: true }));
    const s = ghost.ghostSendToggleState();
    expect(s.enabled).toBe(true);
    expect(s.source).toBe("file");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Layer 2 — positive style allowlist (toggle enabled for all cases)
// ═══════════════════════════════════════════════════════════════════════════
describe("positive style allowlist", () => {
  beforeEach(() => { process.env.GHOST_SEND_ENABLED = "1"; });

  const BLOCKED_CASES = [
    ["ghost_emoji",        "sure thing 👻"],
    ["markdown_bold",      "that works — **see you then**"],
    ["code_fence",         "here you go\n```js\nconsole.log(1)\n```"],
    ["single_backtick",    "run `ls -la` and send me the output"],
    ["tag_prefix",         "[Ghost] yeah I can do that"],
    ["markdown_bullets",   "- first thing\n- second thing\n- third thing"],
    ["markdown_link",      "check [this](https://example.com) out"],
    ["essay_shape",        "First paragraph of a long reply.\n\nSecond paragraph continues the essay."],
    ["assistant_register", "As an AI language model I cannot make plans for you"],
    ["too_long",           "a".repeat(700)],
    ["cjk_chars",          "好的没问题"],
  ];

  test.each(BLOCKED_CASES)(
    "style_blocked_%s: passes G3 denylist but fails style allowlist → blocked, zero wire",
    async (_name, text) => {
      const ok = await ghost.bbSendMessage(CHAT_GUID, text);
      expect(ok).toBe(false);
      expect(wireCalls()).toBe(0);
    }
  );

  const ALLOWED_CASES = [
    ["plain_casual",       CASUAL_TEXT],
    ["typographic_punct",  "don’t worry about it — I’ll figure it out"],
    ["allowed_emoji",      "lmaooo 😂 that's wild"],
    ["multi_line_casual",  "yeah\nsounds good\nsee ya"],
  ];

  test.each(ALLOWED_CASES)(
    "style_allowed_%s: casual-register text passes the new layer",
    async (_name, text) => {
      const ok = await ghost.bbSendMessage(CHAT_GUID, text);
      expect(ok).toBe(true);
      expect(wireCalls()).toBe(1);
    }
  );

  test("styleAllowlistViolation returns reason strings, null for casual text", () => {
    expect(ghost.styleAllowlistViolation(CASUAL_TEXT)).toBeNull();
    expect(ghost.styleAllowlistViolation("sure 👻")).toBeTruthy();
    expect(ghost.styleAllowlistViolation("**bold**")).toBeTruthy();
    expect(ghost.styleAllowlistViolation("```\nfence\n```")).toBeTruthy();
    expect(ghost.styleAllowlistViolation("[Tag] hi")).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Preservation — pre-existing gates still enforced AFTER the new layers pass
// ═══════════════════════════════════════════════════════════════════════════
describe("gate preservation with new layers passing", () => {
  beforeEach(() => { process.env.GHOST_SEND_ENABLED = "1"; });

  test("drift_marker_still_blocked: G3 denylist fires with toggle enabled", async () => {
    const ok = await ghost.bbSendMessage(CHAT_GUID, "[KleinClaw-Ghost] internal text");
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });

  test("recipient_allowlist_still_blocked: G2 fires for non-allowlisted DM", async () => {
    const ok = await ghost.bbSendMessage("iMessage;-;+15559999999", CASUAL_TEXT);
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });

  test("empty_guard_still_blocked: empty outbound never reaches wire", async () => {
    const ok = await ghost.bbSendMessage(CHAT_GUID, "   ");
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });
});
