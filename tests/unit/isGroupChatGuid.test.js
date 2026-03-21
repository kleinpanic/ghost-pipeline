/**
 * isGroupChatGuid tests — verifies group vs direct chat detection across all BB protocols.
 *
 * Bugs caught by these tests:
 *   - Original filter used !/^iMessage;-;\+/ which wrongly flagged SMS, iMessageLite,
 *     and RCS direct messages as group chats, silently dropping Dad/others.
 */

const { isGroupChatGuid } = require("../../src/ghost.js");

describe("isGroupChatGuid — direct message GUIDs (should return false)", () => {
  test("iMessage direct", () => {
    expect(isGroupChatGuid("iMessage;-;+15551234567")).toBe(false);
  });

  test("SMS direct", () => {
    expect(isGroupChatGuid("SMS;-;+15559876543")).toBe(false);
  });

  test("iMessageLite direct", () => {
    expect(isGroupChatGuid("iMessageLite;-;+15551234567")).toBe(false);
  });

  test("RCS direct", () => {
    expect(isGroupChatGuid("RCS;-;+15551234567")).toBe(false);
  });
});

describe("isGroupChatGuid — group chat GUIDs (should return true)", () => {
  test("iMessage group chat", () => {
    expect(isGroupChatGuid("iMessage;+;chat123456789012345")).toBe(true);
  });

  test("SMS group chat", () => {
    expect(isGroupChatGuid("SMS;+;chat999888777666555")).toBe(true);
  });

  test("iMessageLite group", () => {
    expect(isGroupChatGuid("iMessageLite;+;chat111222333")).toBe(true);
  });
});

describe("isGroupChatGuid — fallback to participants when no chatGuid", () => {
  test("empty chatGuid + 2 participants → group", () => {
    expect(isGroupChatGuid("", { participants: ["+1111", "+2222"] })).toBe(true);
  });

  test("empty chatGuid + 1 participant → not group", () => {
    expect(isGroupChatGuid("", { participants: ["+1111"] })).toBe(false);
  });

  test("null chatGuid + no participants → not group", () => {
    expect(isGroupChatGuid(null, {})).toBe(false);
  });
});
