"use strict";

// 90-01 regression: nightly `ghost learn` failed every run with
//   "Failed to fetch chats: mcporter bb_list_chats: undefined"   (ghost-learn.log)
// Root cause 1: spawnSync("mcporter", ...) relied on bare-name PATH resolution;
// cron's minimal PATH omits the npm global prefix (~/.local/share/npm/bin), so
// the spawn ENOENT'd (status null, stderr undefined → the opaque "undefined").
// Root cause 2 (surfaced once resolution was fixed): mcporter's stdout is
// truncated at ~145KB on large tool results when written to a pipe (async
// writes dropped at child exit). Reproduced live 2026-08-06: limit=750
// bb_get_chat_messages → 145,577 bytes truncated via pipe, 184,969 bytes
// complete via file fd. mcporterCallSync therefore captures stdout through a
// temp-file fd (synchronous writes), not a pipe.
// The CLI arg shape itself (`call bluebubbles.<tool> --args <json>`) is still
// valid on mcporter 0.8.1 — pinned live 2026-08-06 via `mcporter call --help`.

const fs = require("fs");
const path = require("path");

jest.mock("child_process", () => {
  const real = jest.requireActual("child_process");
  return { ...real, spawnSync: jest.fn() };
});
const cp = require("child_process");
const ghost = require("../../src/ghost.js");

const HOME = process.env.HOME || "/home/broklein";

// Mock helper: behave like mcporter writing `payload` to whatever stdout the
// caller wired up (fd number in stdio[1]), mirroring the real capture path.
function mockMcporterWriting(payload) {
  cp.spawnSync.mockImplementation((bin, args, opts) => {
    const out = opts && Array.isArray(opts.stdio) ? opts.stdio[1] : null;
    if (typeof out === "number") fs.writeSync(out, payload);
    return { status: 0, stdout: null, stderr: "" };
  });
}

describe("mcporterCallSync (learn path)", () => {
  beforeEach(() => cp.spawnSync.mockReset());

  test("resolves mcporter to the absolute npm-global binary when it exists", () => {
    const npmBin = path.join(HOME, ".local", "share", "npm", "bin", "mcporter");
    if (fs.existsSync(npmBin)) {
      expect(ghost.MCPORTER_BIN).toBe(npmBin);
    } else {
      // fallback: bare name (PATH resolution) is the only remaining option
      expect(ghost.MCPORTER_BIN).toBe("mcporter");
    }
  });

  test("invokes the current mcporter CLI shape: call bluebubbles.<tool> --args <json>", async () => {
    mockMcporterWriting(JSON.stringify({ chats: [] }));
    const data = await ghost.mcporterCallSync("bb_list_chats", { limit: 300, offset: 0 });
    expect(data).toEqual({ chats: [] });
    expect(cp.spawnSync).toHaveBeenCalledTimes(1);
    const [bin, args] = cp.spawnSync.mock.calls[0];
    expect(bin).toBe(ghost.MCPORTER_BIN);
    expect(args).toEqual([
      "call",
      "bluebubbles.bb_list_chats",
      "--args",
      JSON.stringify({ limit: 300, offset: 0 }),
    ]);
  });

  test("regression: captures stdout via file fd so >145KB payloads survive intact", async () => {
    // build a payload comfortably past the observed 145,577-byte pipe truncation point
    const big = { count: 1, messages: [{ guid: "X", text: "m".repeat(220000) }] };
    const payload = JSON.stringify(big);
    expect(payload.length).toBeGreaterThan(200000);
    mockMcporterWriting(payload);
    const data = await ghost.mcporterCallSync("bb_get_chat_messages", { chat_guid: "g", limit: 750, sort: "DESC" });
    expect(data.messages[0].text.length).toBe(220000);
  });

  test("regression: spawn failure (ENOENT) surfaces the real reason, not 'undefined'", async () => {
    const enoent = Object.assign(new Error("spawnSync mcporter ENOENT"), { code: "ENOENT" });
    cp.spawnSync.mockReturnValue({ status: null, stdout: null, stderr: undefined, error: enoent });
    let thrown;
    try {
      await ghost.mcporterCallSync("bb_list_chats", {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown.message).toMatch(/ENOENT/);
    expect(thrown.message).not.toMatch(/: undefined$/);
  });
});
