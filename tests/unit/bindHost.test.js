"use strict";

// 90-01: GHOST_BIND_HOST wiring — the serve listen host must come from env
// (process.env wins over .env file), so .env's 127.0.0.1 confines ghost to
// loopback without changing the historical 0.0.0.0 default when unset.

describe("GHOST_BIND_HOST wiring", () => {
  const ORIG = process.env.GHOST_BIND_HOST;

  afterEach(() => {
    jest.resetModules();
    if (ORIG === undefined) delete process.env.GHOST_BIND_HOST;
    else process.env.GHOST_BIND_HOST = ORIG;
  });

  test("process.env GHOST_BIND_HOST overrides everything", () => {
    jest.resetModules();
    process.env.GHOST_BIND_HOST = "127.0.0.2";
    const { BIND_HOST } = require("../../src/ghost.js");
    expect(BIND_HOST).toBe("127.0.0.2");
  });

  test("BIND_HOST is a non-empty string (falls back to .env or 0.0.0.0 default)", () => {
    jest.resetModules();
    delete process.env.GHOST_BIND_HOST;
    const { BIND_HOST } = require("../../src/ghost.js");
    expect(typeof BIND_HOST).toBe("string");
    expect(BIND_HOST.length).toBeGreaterThan(0);
    // repo .env pins 127.0.0.1; absent that, code default is 0.0.0.0
    expect(["127.0.0.1", "0.0.0.0"]).toContain(BIND_HOST);
  });
});
