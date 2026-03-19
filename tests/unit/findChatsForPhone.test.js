/**
 * findChatsForPhone / findChatGuidForPhone tests — verifies chat resolution and scoring
 * across all BB protocols.
 *
 * Bugs caught by these tests:
 *   - iMessageLite;-;+phone was scored as 6 ("other"), falling below SMS chats.
 *   - findChatGuidForPhone was calling GET /api/v1/chat (404) instead of
 *     POST /api/v1/chat/query — tested via mock in integration suite.
 */

const { findChatsForPhone, findChatGuidForPhone } = require("../../src/ghost.js");

const PHONE = "14846342876"; // Dad

function makeChat(guid, participants = []) {
  return { guid, participants, chatIdentifier: guid.split(";").pop() };
}

describe("findChatsForPhone — scoring / priority", () => {
  test("iMessage;-; direct beats SMS;-; direct", () => {
    const chats = [
      makeChat(`SMS;-;+${PHONE}`, [{ address: `+${PHONE}` }]),
      makeChat(`iMessage;-;+${PHONE}`, [{ address: `+${PHONE}` }]),
    ];
    const result = findChatsForPhone(`+${PHONE}`, chats);
    expect(result[0].guid).toBe(`iMessage;-;+${PHONE}`);
  });

  test("iMessageLite;-; scores same tier as iMessage;-;", () => {
    const chats = [
      makeChat(`SMS;-;+${PHONE}`, [{ address: `+${PHONE}` }]),
      makeChat(`iMessageLite;-;+${PHONE}`, [{ address: `+${PHONE}` }]),
    ];
    const result = findChatsForPhone(`+${PHONE}`, chats);
    // iMessageLite should beat SMS (score 0 vs 1)
    expect(result[0].guid).toBe(`iMessageLite;-;+${PHONE}`);
  });

  test("direct SMS beats group iMessage", () => {
    const chats = [
      makeChat(`iMessage;+;chat999`, [{ address: `+${PHONE}` }, { address: "+19999999999" }]),
      makeChat(`SMS;-;+${PHONE}`, [{ address: `+${PHONE}` }]),
    ];
    const result = findChatsForPhone(`+${PHONE}`, chats);
    expect(result[0].guid).toBe(`SMS;-;+${PHONE}`);
  });

  test("RCS;-; scores same tier as SMS;-;", () => {
    const chats = [
      makeChat(`iMessage;+;chat999`, [{ address: `+${PHONE}` }]),
      makeChat(`RCS;-;+${PHONE}`, [{ address: `+${PHONE}` }]),
    ];
    const result = findChatsForPhone(`+${PHONE}`, chats);
    expect(result[0].guid).toBe(`RCS;-;+${PHONE}`);
  });

  test("returns empty array when phone not in any chat", () => {
    const chats = [makeChat("iMessage;-;+19999999999", [{ address: "+19999999999" }])];
    expect(findChatsForPhone("+10000000000", chats)).toHaveLength(0);
  });
});

describe("findChatsForPhone — phone number format tolerance", () => {
  test("matches with or without leading +", () => {
    const chats = [makeChat(`iMessage;-;+${PHONE}`, [{ address: `+${PHONE}` }])];
    expect(findChatsForPhone(PHONE, chats)).toHaveLength(1);
    expect(findChatsForPhone(`+${PHONE}`, chats)).toHaveLength(1);
  });

  test("matches via guid substring when participant list missing", () => {
    const chats = [{ guid: `iMessage;-;+${PHONE}`, participants: [], chatIdentifier: `+${PHONE}` }];
    expect(findChatsForPhone(`+${PHONE}`, chats)).toHaveLength(1);
  });
});

describe("findChatGuidForPhone — returns best guid", () => {
  test("returns iMessage guid over SMS for same phone", () => {
    const chats = [
      makeChat(`SMS;-;+${PHONE}`, [{ address: `+${PHONE}` }]),
      makeChat(`iMessage;-;+${PHONE}`, [{ address: `+${PHONE}` }]),
    ];
    expect(findChatGuidForPhone(`+${PHONE}`, chats)).toBe(`iMessage;-;+${PHONE}`);
  });

  test("returns null when no match", () => {
    expect(findChatGuidForPhone("+10000000000", [])).toBeNull();
  });
});
