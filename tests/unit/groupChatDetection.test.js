/**
 * Group chat detection — tests all paths in isGroupChatGuid().
 * Ensures group messages NEVER result in individual DMs.
 */

const { isGroupChatGuid } = require("../../src/ghost.js");

describe("isGroupChatGuid — chatGuid format", () => {
  test('";+;" in chatGuid → group', () => {
    expect(isGroupChatGuid("iMessage;+;chat123456789")).toBe(true);
  });

  test('";-;" in chatGuid → NOT group', () => {
    expect(isGroupChatGuid("iMessage;-;+15551234567")).toBe(false);
  });

  test("SMS;-; → NOT group", () => {
    expect(isGroupChatGuid("SMS;-;+15551234567")).toBe(false);
  });

  test("RCS;-; → NOT group", () => {
    expect(isGroupChatGuid("RCS;-;+15551234567")).toBe(false);
  });
});

describe("isGroupChatGuid — participants array", () => {
  test("2+ participants → group", () => {
    expect(isGroupChatGuid("", {
      participants: [
        { address: "+15551234567" },
        { address: "+15559876543" },
      ],
    })).toBe(true);
  });

  test("1 participant → NOT group", () => {
    expect(isGroupChatGuid("", {
      participants: [{ address: "+15551234567" }],
    })).toBe(false);
  });

  test("0 participants → NOT group", () => {
    expect(isGroupChatGuid("", { participants: [] })).toBe(false);
  });
});

describe("isGroupChatGuid — embedded chats array (BB workaround)", () => {
  test("chats array with ;+; guid → group", () => {
    expect(isGroupChatGuid("SMS;-;+15551234567", {
      chats: [{ guid: "iMessage;+;chat999888" }],
    })).toBe(true);
  });

  test("chats array with 2+ participants → group", () => {
    expect(isGroupChatGuid("SMS;-;+15551234567", {
      chats: [{
        guid: "SMS;-;+15551234567",
        participants: [
          { address: "+15551234567" },
          { address: "+15559876543" },
        ],
      }],
    })).toBe(true);
  });

  test("chats array with 1 participant and ;-; guid → NOT group", () => {
    expect(isGroupChatGuid("SMS;-;+15551234567", {
      chats: [{
        guid: "SMS;-;+15551234567",
        participants: [{ address: "+15551234567" }],
      }],
    })).toBe(false);
  });
});

describe("isGroupChatGuid — groupName field", () => {
  test("groupName present → group", () => {
    expect(isGroupChatGuid("SMS;-;+15551234567", {
      groupName: "The Boys",
    })).toBe(true);
  });

  test("group_name (snake_case) present → group", () => {
    expect(isGroupChatGuid("SMS;-;+15551234567", {
      group_name: "The Boys",
    })).toBe(true);
  });

  test("no groupName, no chats, 1 participant → NOT group", () => {
    expect(isGroupChatGuid("SMS;-;+15551234567", {
      participants: [{ address: "+15551234567" }],
    })).toBe(false);
  });
});

describe("isGroupChatGuid — real-world regression: Will's group chat", () => {
  // The actual bug: BB fired a webhook with Will's individual handle,
  // but the message came from a group chat. Ghost resolved Will's 1:1
  // chatGuid and DM'd him directly. This test confirms the fix catches it
  // when BB includes the group context in the chats array.
  test("individual handle but chats array reveals group → group", () => {
    expect(isGroupChatGuid("iMessage;-;+15551111111", {
      chats: [
        { guid: "iMessage;+;chat555666777", participants: [
          { address: "+15551111111" },  // contact A
          { address: "+15552222222" },  // contact B (owner)
          { address: "+15553333333" },  // contact C
        ]},
      ],
    })).toBe(true);
  });
});
