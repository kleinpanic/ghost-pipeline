"use strict";

/**
 * sendToggleStyleGate.test.js — 90-03 additive chokepoint layers (RED→GREEN)
 *
 * Pins the two structural layers added INSIDE the sendIMessage chokepoint (G10) per
 * 70-GHOST-RESEARCH §5b + GHOST-TOGGLE addendum and 90-RESEARCH AUTOSEND-FAILCLOSED:
 *
 *   Layer 1 — fail-closed master send toggle:
 *     absent / off / unparseable state ⇒ sendIMessage returns false, ZERO wire
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
 *
 *   NAT-25 (2026-11-04): the wire is the native imessage channel, and the recipient
 *     check is mandatory: only an allowlisted E.164 handle (or the owner) is sent to.
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ─── Temp workspace (must precede require of ghost.js) ──────────────────────
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-toggle-"));
process.env.HOME    = tmpHome;
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

const ghost = require("../../src/ghost.js");

// ─── Capture every wire attempt (native send replaced by a recorder) ─────────
global.__toggleWireLog = [];
ghost.setTransport({
  sendIMessage: async (target, text) => { global.__toggleWireLog.push({ target, text }); return { ok: true }; },
});

const TOGGLE_FILE = path.join(dataDir, "ghost-send-enabled.json");
const TARGET      = `+${ALLOWED_PHONE}`;
const CASUAL_TEXT = "yeah for sure, running a bit late tho";

function wireCalls() {
  return global.__toggleWireLog.length;
}

beforeEach(() => {
  global.__toggleWireLog = [];
  delete process.env.GHOST_SEND_ENABLED;
  try { fs.unlinkSync(TOGGLE_FILE); } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════
//  Layer 1 — fail-closed toggle
// ═══════════════════════════════════════════════════════════════════════════
describe("fail-closed send toggle", () => {
  test("toggle_absent_blocks: no env, no state file → blocked, zero wire calls", async () => {
    const ok = await ghost.sendIMessage(TARGET, CASUAL_TEXT);
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });

  test("toggle_file_disabled_blocks: {\"enabled\": false} → blocked", async () => {
    fs.writeFileSync(TOGGLE_FILE, JSON.stringify({ enabled: false }));
    const ok = await ghost.sendIMessage(TARGET, CASUAL_TEXT);
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });

  test("toggle_file_corrupt_blocks: unparseable state file → blocked (fail-closed)", async () => {
    fs.writeFileSync(TOGGLE_FILE, "{not json!!");
    const ok = await ghost.sendIMessage(TARGET, CASUAL_TEXT);
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });

  test("toggle_file_wrong_shape_blocks: {\"enabled\": \"yes\"} (non-boolean) → blocked", async () => {
    fs.writeFileSync(TOGGLE_FILE, JSON.stringify({ enabled: "yes" }));
    const ok = await ghost.sendIMessage(TARGET, CASUAL_TEXT);
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });

  test("toggle_env_enables: GHOST_SEND_ENABLED=1 → send proceeds through gates to wire", async () => {
    process.env.GHOST_SEND_ENABLED = "1";
    const ok = await ghost.sendIMessage(TARGET, CASUAL_TEXT);
    expect(ok).toBe(true);
    expect(wireCalls()).toBe(1);
    expect(global.__toggleWireLog[0]).toEqual({ target: TARGET, text: CASUAL_TEXT });
  });

  test("toggle_file_enables: {\"enabled\": true} → send proceeds (runtime, no restart)", async () => {
    fs.writeFileSync(TOGGLE_FILE, JSON.stringify({ enabled: true }));
    const ok = await ghost.sendIMessage(TARGET, CASUAL_TEXT);
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
      const ok = await ghost.sendIMessage(TARGET, text);
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
      const ok = await ghost.sendIMessage(TARGET, text);
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
    const ok = await ghost.sendIMessage(TARGET, "[KleinClaw-Ghost] internal text");
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });

  test("recipient_allowlist_still_blocked: G2 fires for non-allowlisted DM", async () => {
    const ok = await ghost.sendIMessage("+15559999999", CASUAL_TEXT);
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });

  test.each([
    ["chat guid", `iMessage;-;+${ALLOWED_PHONE}`],
    ["any;-; guid", `any;-;+${ALLOWED_PHONE}`],
    ["imsg chat id", "42"],
    ["email handle", "someone@example.com"],
    ["digits without +", ALLOWED_PHONE],
  ])("non_e164_target_blocked (%s): fails closed, zero wire", async (_label, target) => {
    const ok = await ghost.sendIMessage(target, CASUAL_TEXT);
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });

  test("native_send_failure_returns_false: channel unavailable → false", async () => {
    ghost.setTransport({ sendIMessage: async () => ({ ok: false, error: "Channel is unavailable: imessage" }) });
    try {
      expect(await ghost.sendIMessage(TARGET, CASUAL_TEXT)).toBe(false);
    } finally {
      ghost.setTransport({
        sendIMessage: async (target, text) => { global.__toggleWireLog.push({ target, text }); return { ok: true }; },
      });
    }
  });

  test("empty_guard_still_blocked: empty outbound never reaches wire", async () => {
    const ok = await ghost.sendIMessage(TARGET, "   ");
    expect(ok).toBe(false);
    expect(wireCalls()).toBe(0);
  });
});
