"use strict";
/**
 * Tests for the three bug fixes:
 *   BUG-1b — shortId registry lookup (OC-managed button clicks)
 *   BUG-2  — timestamp normalization (seconds vs ms)
 *   BUG-3  — Klein recently active gate
 */

const path = require("path");
const os   = require("os");
const fs   = require("fs");

// Isolate filesystem to temp dir
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-bugfix-test-"));
process.env.HOME = tmpDir;
fs.mkdirSync(path.join(tmpDir, ".openclaw", "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, ".openclaw", "workspace-ghost", "governance"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, ".openclaw", "workspace-ghost", "memory", "contacts"), { recursive: true });

const {
  normalizeTs,
  loadButtonRegistry,
  saveButtonRegistry,
  BUTTON_REGISTRY_FILE,
} = require("../../src/ghost");

// ─────────────────────────────────────────────────────────────────────────────
// BUG-2 — normalizeTs: timestamp normalization (seconds ↔ ms)
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeTs — BUG-2: timestamp normalization", () => {
  test("already-ms timestamp (13 digits) → returned as-is", () => {
    const ms = 1_710_000_000_000; // 13-digit
    expect(normalizeTs(ms)).toBe(ms);
  });

  test("seconds timestamp (10 digits) → multiplied by 1000", () => {
    const sec = 1_710_000_000; // 10-digit
    expect(normalizeTs(sec)).toBe(sec * 1000);
  });

  test("boundary value: exactly 10_000_000_000 treated as ms", () => {
    // > 9_999_999_999 → already ms
    expect(normalizeTs(10_000_000_000)).toBe(10_000_000_000);
  });

  test("boundary value: exactly 9_999_999_999 treated as seconds", () => {
    expect(normalizeTs(9_999_999_999)).toBe(9_999_999_999 * 1000);
  });

  test("null/undefined → 0", () => {
    expect(normalizeTs(null)).toBe(0);
    expect(normalizeTs(undefined)).toBe(0);
  });

  test("0 → 0", () => {
    expect(normalizeTs(0)).toBe(0);
  });

  test("collision check: second-based ts correctly exceeds arrivedAt (ms)", () => {
    // Before fix: (ts_sec > arrivedAt_ms) → false (seconds < ms always)
    // After fix: normalizeTs(ts_sec) > arrivedAt_ms → correctly catches Klein's reply
    const arrivedAt  = Date.now();
    const tsSec      = Math.floor((arrivedAt + 5000) / 1000); // 5s AFTER arrival, in seconds
    expect(normalizeTs(tsSec)).toBeGreaterThan(arrivedAt);
  });

  test("collision check: second-based ts BEFORE arrivedAt not falsely flagged", () => {
    const arrivedAt = Date.now();
    const tsSec     = Math.floor((arrivedAt - 60000) / 1000); // 1 min BEFORE arrival
    expect(normalizeTs(tsSec)).toBeLessThan(arrivedAt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-1b — shortId registry (loadButtonRegistry / saveButtonRegistry)
// ─────────────────────────────────────────────────────────────────────────────

describe("button registry — BUG-1b: shortId → draftId lookup", () => {
  const registryPath = path.join(tmpDir, ".openclaw", "data", "ghost-button-registry.json");

  beforeEach(() => {
    // Clean up registry before each test
    try { fs.unlinkSync(registryPath); } catch {}
  });

  test("loadButtonRegistry returns {} when file missing", () => {
    const reg = loadButtonRegistry();
    expect(reg).toEqual({});
  });

  test("saveButtonRegistry writes shortId entries", () => {
    const reg = { abc123: { draftId: "dead1234", action: "send", chatGuid: "iMessage;-;+1234567890", contact: "1234567890", contactName: "Alice", postedAt: new Date().toISOString() } };
    saveButtonRegistry(reg);
    const loaded = loadButtonRegistry();
    expect(loaded.abc123).toBeDefined();
    expect(loaded.abc123.draftId).toBe("dead1234");
    expect(loaded.abc123.action).toBe("send");
  });

  test("saveButtonRegistry trims entries older than 24h", () => {
    const old   = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const fresh = new Date().toISOString();
    const reg   = {
      stale: { draftId: "stale000", action: "send", postedAt: old },
      fresh: { draftId: "fresh111", action: "cancel", postedAt: fresh },
    };
    saveButtonRegistry(reg);
    const loaded = loadButtonRegistry();
    expect(loaded.stale).toBeUndefined(); // trimmed
    expect(loaded.fresh).toBeDefined();    // kept
  });

  test("saveButtonRegistry keeps entries with no postedAt (safety net)", () => {
    const reg = { noTs: { draftId: "abc00000", action: "send" } }; // no postedAt
    saveButtonRegistry(reg);
    const loaded = loadButtonRegistry();
    expect(loaded.noTs).toBeDefined();
  });

  test("round-trip: save then load preserves all fields", () => {
    const entry = {
      draftId:     "1a2b3c4d",
      action:      "cancel",
      contactName: "Bob",
      chatGuid:    "iMessage;-;+15551234567",
      contact:     "15551234567",
      postedAt:    new Date().toISOString(),
    };
    saveButtonRegistry({ xyz789: entry });
    const loaded = loadButtonRegistry();
    expect(loaded.xyz789).toMatchObject(entry);
  });

  test("multiple shortIds stored independently", () => {
    const now = new Date().toISOString();
    saveButtonRegistry({
      sendBtn:   { draftId: "aabbccdd", action: "send",   postedAt: now },
      cancelBtn: { draftId: "aabbccdd", action: "cancel", postedAt: now },
    });
    const loaded = loadButtonRegistry();
    expect(loaded.sendBtn.action).toBe("send");
    expect(loaded.cancelBtn.action).toBe("cancel");
    expect(loaded.sendBtn.draftId).toBe(loaded.cancelBtn.draftId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-3 — kleinRecentlyActive gate (unit-level logic test)
// ─────────────────────────────────────────────────────────────────────────────

describe("kleinRecentlyActive gate — BUG-3: skip draft if Klein active", () => {
  // Pure logic test mirroring the runPreflight() check:
  //   const kleinRecentlyActive = messages.some(m =>
  //     (m.isFromMe === true || m.from === 'me') &&
  //     normalizeTs(m.dateCreated) > tenMinAgo &&
  //     normalizeTs(m.dateCreated) < arrivedAt
  //   );

  function kleinRecentlyActiveFn(messages, arrivedAt) {
    const tenMinAgo = arrivedAt - 10 * 60 * 1000;
    return messages.some(m =>
      (m.isFromMe === true || m.from === "me") &&
      normalizeTs(m.dateCreated) > tenMinAgo &&
      normalizeTs(m.dateCreated) < arrivedAt
    );
  }

  test("no messages → not recently active", () => {
    expect(kleinRecentlyActiveFn([], Date.now())).toBe(false);
  });

  test("Klein sent a message 5 min ago (ms ts) → recently active", () => {
    const arrivedAt = Date.now();
    const msgs = [{ isFromMe: true, dateCreated: arrivedAt - 5 * 60 * 1000 }];
    expect(kleinRecentlyActiveFn(msgs, arrivedAt)).toBe(true);
  });

  test("Klein sent a message 5 min ago (sec ts) → recently active", () => {
    const arrivedAt = Date.now();
    const tsSec     = Math.floor((arrivedAt - 5 * 60 * 1000) / 1000); // seconds
    const msgs = [{ isFromMe: true, dateCreated: tsSec }];
    expect(kleinRecentlyActiveFn(msgs, arrivedAt)).toBe(true);
  });

  test("Klein sent a message 15 min ago → NOT recently active (beyond 10-min window)", () => {
    const arrivedAt = Date.now();
    const msgs = [{ isFromMe: true, dateCreated: arrivedAt - 15 * 60 * 1000 }];
    expect(kleinRecentlyActiveFn(msgs, arrivedAt)).toBe(false);
  });

  test("message from:me (MCP format) 3 min ago → recently active", () => {
    const arrivedAt = Date.now();
    const msgs = [{ from: "me", dateCreated: arrivedAt - 3 * 60 * 1000 }];
    expect(kleinRecentlyActiveFn(msgs, arrivedAt)).toBe(true);
  });

  test("message from contact (not Klein) 3 min ago → NOT recently active", () => {
    const arrivedAt = Date.now();
    const msgs = [{ isFromMe: false, from: "+15551234567", dateCreated: arrivedAt - 3 * 60 * 1000 }];
    expect(kleinRecentlyActiveFn(msgs, arrivedAt)).toBe(false);
  });

  test("Klein message AFTER arrivedAt (future) → not counted", () => {
    // Safety: messages after arrivedAt shouldn't trigger the gate
    const arrivedAt = Date.now();
    const msgs = [{ isFromMe: true, dateCreated: arrivedAt + 1000 }];
    expect(kleinRecentlyActiveFn(msgs, arrivedAt)).toBe(false);
  });

  test("multiple messages — one in window → recently active", () => {
    const arrivedAt = Date.now();
    const msgs = [
      { isFromMe: false, dateCreated: arrivedAt - 2 * 60 * 1000 }, // contact msg — doesn't count
      { isFromMe: true,  dateCreated: arrivedAt - 8 * 60 * 1000 }, // Klein 8min ago — counts
    ];
    expect(kleinRecentlyActiveFn(msgs, arrivedAt)).toBe(true);
  });
});
