/**
 * REGRESSION TEST — The 1:25am incident
 *
 * Root cause: ghost checked m.isFromMe but MCP returns m.from === "me".
 * kleinRepliedSince() never detected Klein's prior reply → auto-sent to Mom at 1:25am.
 * This test must NEVER be deleted. If it fails, ghost will repeat the incident.
 */

const { isFromKlein } = require("../../src/ghost.js");

describe("REGRESSION: isFromKlein detects both BB and MCP field formats", () => {
  test("BB direct HTTP format: isFromMe:true → Klein's message", () => {
    expect(isFromKlein({ isFromMe: true, text: "hey" })).toBe(true);
  });

  test("MCP/mcporter format: from:'me' → Klein's message [CRITICAL — caused 1:25am incident]", () => {
    expect(isFromKlein({ from: "me", text: "hey" })).toBe(true);
  });

  test("Incoming message: from:phone → NOT Klein", () => {
    expect(isFromKlein({ from: "+15558887777", text: "hi" })).toBe(false);
  });

  test("Incoming message: isFromMe:false → NOT Klein", () => {
    expect(isFromKlein({ isFromMe: false })).toBe(false);
  });

  test("Both fields false/absent → NOT Klein", () => {
    expect(isFromKlein({})).toBe(false);
  });
});
