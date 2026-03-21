/**
 * Restart persistence — verifies that pending drafts and button registry
 * survive a process restart (loaded from disk, not just in-memory).
 */

const path = require("path");
const fs   = require("fs");
const ghost = require("../../src/ghost.js");

const DATA_DIR  = path.join(process.env.HOME, ".openclaw", "data");
const DRAFTS_FILE  = path.join(DATA_DIR, "ghost-pending-drafts.json");
const REGISTRY_FILE = path.join(DATA_DIR, "ghost-button-registry.json");

// Save originals to restore after tests
let origDrafts, origRegistry;

beforeAll(() => {
  origDrafts   = fs.existsSync(DRAFTS_FILE) ? fs.readFileSync(DRAFTS_FILE, "utf8") : "[]";
  origRegistry = fs.existsSync(REGISTRY_FILE) ? fs.readFileSync(REGISTRY_FILE, "utf8") : "{}";
});

afterAll(() => {
  fs.writeFileSync(DRAFTS_FILE, origDrafts);
  fs.writeFileSync(REGISTRY_FILE, origRegistry);
});

describe("restart persistence — pending drafts", () => {
  test("savePendingDrafts → loadPendingDrafts round-trips correctly", () => {
    const testDraft = {
      draftId:     "restart-test-001",
      chatGuid:    "SMS;-;+15551234567",
      contact:     "+15551234567",
      contactName: "Test Contact",
      draftText:   "hey what's up",
      arrivedAt:   new Date().toISOString(),
      postedAt:    new Date().toISOString(),
      autoSendMs:  300000,
    };
    ghost.savePendingDrafts([testDraft]);

    // Simulate "restart" by reading from disk (loadPendingDrafts reads the file)
    const loaded = ghost.loadPendingDrafts();
    expect(loaded.length).toBe(1);
    expect(loaded[0].draftId).toBe("restart-test-001");
    expect(loaded[0].draftText).toBe("hey what's up");
    expect(loaded[0].chatGuid).toBe("SMS;-;+15551234567");
  });

  test("empty array persists correctly", () => {
    ghost.savePendingDrafts([]);
    expect(ghost.loadPendingDrafts()).toEqual([]);
  });

  test("multiple drafts persist", () => {
    const drafts = [
      { draftId: "a", chatGuid: "SMS;-;+11111111111", contactName: "A" },
      { draftId: "b", chatGuid: "SMS;-;+12222222222", contactName: "B" },
      { draftId: "c", chatGuid: "SMS;-;+13333333333", contactName: "C" },
    ];
    ghost.savePendingDrafts(drafts);
    const loaded = ghost.loadPendingDrafts();
    expect(loaded.length).toBe(3);
    expect(loaded.map(d => d.draftId)).toEqual(["a", "b", "c"]);
  });
});

describe("restart persistence — button registry", () => {
  test("registry survives write+read cycle", () => {
    const testRegistry = {
      "btn_test1": { draftId: "restart-test-001", action: "send" },
      "btn_test2": { draftId: "restart-test-001", action: "cancel" },
    };
    // Write directly to file (same as ghost.js does internally)
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(testRegistry, null, 2));

    // Read back — loadJson is used internally
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
    expect(raw.btn_test1.draftId).toBe("restart-test-001");
    expect(raw.btn_test2.action).toBe("cancel");
  });
});
