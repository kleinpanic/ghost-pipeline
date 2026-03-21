const { normalizePhone } = require("../../src/ghost.js");

describe("normalizePhone", () => {
  test("E164 with + → strips plus, returns 11 digits", () => {
    expect(normalizePhone("+15551234567")).toBe("15551234567");
  });
  test("10-digit → prepends 1", () => {
    expect(normalizePhone("5551234567")).toBe("15551234567");
  });
  test("11-digit already normalized → passthrough", () => {
    expect(normalizePhone("15551234567")).toBe("15551234567");
  });
  test("dashes/spaces stripped", () => {
    expect(normalizePhone("555-123-4567")).toBe("15551234567");
  });
  test("null/undefined → empty string", () => {
    expect(normalizePhone(null)).toBe("");
    expect(normalizePhone(undefined)).toBe("");
    expect(normalizePhone("")).toBe("");
  });
});
