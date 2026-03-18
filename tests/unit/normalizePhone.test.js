const { normalizePhone } = require("../../src/ghost.js");

describe("normalizePhone", () => {
  test("E164 with + → strips plus, returns 11 digits", () => {
    expect(normalizePhone("+14847070468")).toBe("14847070468");
  });
  test("10-digit → prepends 1", () => {
    expect(normalizePhone("4847070468")).toBe("14847070468");
  });
  test("11-digit already normalized → passthrough", () => {
    expect(normalizePhone("14847070468")).toBe("14847070468");
  });
  test("dashes/spaces stripped", () => {
    expect(normalizePhone("484-707-0468")).toBe("14847070468");
  });
  test("null/undefined → empty string", () => {
    expect(normalizePhone(null)).toBe("");
    expect(normalizePhone(undefined)).toBe("");
    expect(normalizePhone("")).toBe("");
  });
});
