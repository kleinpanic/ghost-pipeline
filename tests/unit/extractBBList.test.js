const { extractBBList } = require("../../src/ghost.js");

describe("extractBBList", () => {
  test("{chats: [...]} → array", () => {
    expect(extractBBList({ chats: [{ id: 1 }] })).toEqual([{ id: 1 }]);
  });
  test("{messages: [...]} → array", () => {
    expect(extractBBList({ messages: [{ id: 2 }] })).toEqual([{ id: 2 }]);
  });
  test("{data: [...]} → array", () => {
    expect(extractBBList({ data: [{ id: 3 }] })).toEqual([{ id: 3 }]);
  });
  test("raw array → passthrough", () => {
    expect(extractBBList([{ id: 4 }])).toEqual([{ id: 4 }]);
  });
  test("null → empty array", () => {
    expect(extractBBList(null)).toEqual([]);
  });
  test("empty object → empty array", () => {
    expect(extractBBList({})).toEqual([]);
  });
  test("empty arrays → empty array", () => {
    expect(extractBBList({ chats: [] })).toEqual([]);
  });
});
