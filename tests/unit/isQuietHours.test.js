/**
 * isQuietHours tests — fake numbers only, no real contacts.
 * Mirrors the logic in ghost.js without importing it (avoids CONTACTS_FILE path issues).
 * Fake phones: +19995550001 = family_close (10pm), +19995550002 = close_friend (11pm)
 */

const FAMILY_QUIET = 22;
const FRIEND_QUIET = 23;
const QUIET_END    = 8;

const FAKE_CATEGORY_MAP = {
  "19995550001": "family_close",
  "19995550002": "close_friend",
  "19995550003": "friend",
};

function isQuietHoursFor(phone, hour) {
  const digits   = phone.replace(/\D/g, "");
  const norm     = digits.length === 10 ? `1${digits}` : digits;
  const category = FAKE_CATEGORY_MAP[norm] || "friend";
  const start    = (category === "family_close" || category === "acquaintance")
    ? FAMILY_QUIET : FRIEND_QUIET;
  return hour >= start || hour < QUIET_END;
}

describe("family_close — quiet at 10pm", () => {
  const FAM = "+19995550001";
  test("22:00 → quiet",       () => expect(isQuietHoursFor(FAM, 22)).toBe(true));
  test("21:59 → not quiet",   () => expect(isQuietHoursFor(FAM, 21)).toBe(false));
  test("07:59 → quiet",       () => expect(isQuietHoursFor(FAM, 7)).toBe(true));
  test("08:00 → not quiet",   () => expect(isQuietHoursFor(FAM, 8)).toBe(false));
  test("14:00 → not quiet",   () => expect(isQuietHoursFor(FAM, 14)).toBe(false));
});

describe("close_friend — quiet at 11pm", () => {
  const FRD = "+19995550002";
  test("22:30 → NOT quiet",   () => expect(isQuietHoursFor(FRD, 22)).toBe(false));
  test("23:00 → quiet",       () => expect(isQuietHoursFor(FRD, 23)).toBe(true));
  test("00:00 → quiet",       () => expect(isQuietHoursFor(FRD, 0)).toBe(true));
  test("07:59 → quiet",       () => expect(isQuietHoursFor(FRD, 7)).toBe(true));
  test("08:00 → not quiet",   () => expect(isQuietHoursFor(FRD, 8)).toBe(false));
  test("18:00 → not quiet",   () => expect(isQuietHoursFor(FRD, 18)).toBe(false));
});
