/**
 * Contact parser tests — verifies CONTACTS.md 5-field format parses correctly.
 * Uses the real CONTACTS.md (workspace-ghost/governance/CONTACTS.md).
 */

const { loadAllowlist, loadContactsMap } = require("../../src/ghost.js");

describe("loadAllowlist — 5-field format parsing", () => {
  let contacts;

  beforeAll(() => {
    contacts = loadAllowlist();
  });

  test("returns 9 contacts", () => {
    expect(contacts.length).toBe(9);
  });

  test("Brenda parses as family_close with alias Brenda", () => {
    const c = contacts.find(c => c.phone === "14847070468");
    expect(c).toBeDefined();
    expect(c.category).toBe("family_close");
    expect(c.alias).toBe("Brenda");
  });

  test("Nick parses as family_close with alias Nick", () => {
    const c = contacts.find(c => c.phone === "14846342876");
    expect(c).toBeDefined();
    expect(c.category).toBe("family_close");
    expect(c.alias).toBe("Nick");
  });

  test("Sri parses as close_friend", () => {
    const c = contacts.find(c => c.phone === "15715775911");
    expect(c).toBeDefined();
    expect(c.category).toBe("close_friend");
    expect(c.alias).toBe("Sri");
  });

  test("Sam J retains full alias 'Sam J'", () => {
    const c = contacts.find(c => c.phone === "14344227737");
    expect(c).toBeDefined();
    expect(c.alias).toBe("Sam J");
  });

  test("no contact has alias 'family_close' or 'close_friend' (category not leaking into alias)", () => {
    for (const c of contacts) {
      expect(c.alias).not.toMatch(/family_close|close_friend|friend|acquaintance/);
    }
  });
});

describe("loadContactsMap — numToCategory populated", () => {
  test("returns numToCategory for all contacts", () => {
    const { numToCategory } = loadContactsMap();
    expect(numToCategory["14847070468"]).toBe("family_close"); // Brenda
    expect(numToCategory["14846342876"]).toBe("family_close"); // Nick
    expect(numToCategory["15715775911"]).toBe("close_friend"); // Sri
    expect(numToCategory["14344098567"]).toBe("friend");       // Gibbs
  });
});
