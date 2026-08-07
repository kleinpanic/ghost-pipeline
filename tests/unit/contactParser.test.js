/**
 * Contact parser tests — verifies CONTACTS.md 4-field + 5-field formats parse correctly.
 *
 * 90-03: rewritten against a synthetic fixture. Previously these tests read the LIVE
 * workspace-ghost/governance/CONTACTS.md and pinned specific operator contacts; that
 * file is operator-editable governance data (the 2026-08-06 allowlist trim broke the
 * pins). The fixture reproduces every format shape the old tests covered — 5-field
 * category entries, description fields that must NOT leak into the alias, and legacy
 * 4-field multi-word aliases — with synthetic numbers.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-contacts-"));
process.env.HOME = tmpHome;

const govDir = path.join(tmpHome, ".openclaw", "workspace-ghost", "governance");
fs.mkdirSync(govDir, { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".openclaw", "data"), { recursive: true });

fs.writeFileSync(
  path.join(govDir, "CONTACTS.md"),
  [
    "# Test Contacts",
    "<!-- CONTACT_ALLOWLIST_START -->",
    // 5-field: category + description (description must not become the alias)
    "- Alpha | +15550000001 | ask | family_close | closest family, fastest tier",
    "- Bravo | +15550000002 | ask | family_close | sibling",
    "- Charlie | +15550000003 | ask | close_friend | Android phone for live test",
    "- Delta | +15550000004 | ask | friend | met at work",
    "- Echo | +15550000005 | ask | acquaintance | rarely texts",
    // legacy 4-field: label IS the alias (multi-word alias preserved)
    "- Foxtrot Person | +15550000006 | ask | Fox T",
    // legacy 4-field with generic label → falls back to name field
    "- Golf | +15550000007 | ask | friend",
    "<!-- CONTACT_ALLOWLIST_END -->",
  ].join("\n") + "\n"
);

const { loadAllowlist, loadContactsMap } = require("../../src/ghost.js");

describe("loadAllowlist — 5-field format parsing", () => {
  let contacts;

  beforeAll(() => {
    contacts = loadAllowlist();
  });

  test("returns all 7 fixture contacts", () => {
    expect(contacts.length).toBe(7);
  });

  test("Alpha parses as family_close with alias Alpha", () => {
    const c = contacts.find(c => c.phone === "15550000001");
    expect(c).toBeDefined();
    expect(c.category).toBe("family_close");
    expect(c.alias).toBe("Alpha");
  });

  test("Delta parses as friend", () => {
    const c = contacts.find(c => c.phone === "15550000004");
    expect(c).toBeDefined();
    expect(c.category).toBe("friend");
    expect(c.alias).toBe("Delta");
  });

  test("Echo parses as acquaintance", () => {
    const c = contacts.find(c => c.phone === "15550000005");
    expect(c).toBeDefined();
    expect(c.category).toBe("acquaintance");
    expect(c.alias).toBe("Echo");
  });

  test("Charlie alias is 'Charlie', not the description field", () => {
    const c = contacts.find(c => c.phone === "15550000003");
    expect(c).toBeDefined();
    expect(c.category).toBe("close_friend");
    expect(c.alias).toBe("Charlie");
    expect(c.alias).not.toContain("Android");
    expect(c.alias).not.toContain("live test");
  });

  test("legacy 4-field multi-word alias 'Fox T' preserved", () => {
    const c = contacts.find(c => c.phone === "15550000006");
    expect(c).toBeDefined();
    expect(c.alias).toBe("Fox T");
  });

  test("legacy 4-field generic label falls back to name field", () => {
    const c = contacts.find(c => c.phone === "15550000007");
    expect(c).toBeDefined();
    expect(c.alias).toBe("Golf");
    expect(c.category).toBe("friend");
  });

  test("no contact has alias 'family_close' or 'close_friend' (category not leaking into alias)", () => {
    for (const c of contacts) {
      expect(c.alias).not.toMatch(/family_close|close_friend|acquaintance/);
    }
  });

  test("no contact alias is a long description (5-field description not leaking into alias)", () => {
    for (const c of contacts) {
      expect(c.alias.length).toBeLessThan(30);
    }
  });
});

describe("loadContactsMap — numToCategory populated", () => {
  test("returns numToCategory for all contacts", () => {
    const { numToCategory } = loadContactsMap();
    expect(numToCategory["15550000001"]).toBe("family_close"); // Alpha
    expect(numToCategory["15550000002"]).toBe("family_close"); // Bravo
    expect(numToCategory["15550000003"]).toBe("close_friend"); // Charlie
    expect(numToCategory["15550000004"]).toBe("friend");       // Delta
  });
});
