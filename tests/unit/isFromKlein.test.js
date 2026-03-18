const { isFromKlein } = require("../../src/ghost.js");

describe("isFromKlein", () => {
  // Critical regression: the 1:25am incident was caused by ghost NOT detecting
  // Klein's prior reply because it only checked isFromMe, not from:"me"
  test("isFromMe:true → true (direct BB HTTP format)", () => {
    expect(isFromKlein({ isFromMe: true })).toBe(true);
  });
  test('from:"me" → true (MCP/mcporter format)', () => {
    expect(isFromKlein({ from: "me" })).toBe(true);
  });
  test("isFromMe:false → false", () => {
    expect(isFromKlein({ isFromMe: false })).toBe(false);
  });
  test("from: phone number → false", () => {
    expect(isFromKlein({ from: "+14847070468" })).toBe(false);
  });
  test("empty object → false", () => {
    expect(isFromKlein({})).toBe(false);
  });
  test("null → false", () => {
    expect(isFromKlein(null)).toBe(false);
  });
});
