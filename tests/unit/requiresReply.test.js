const { requiresReply } = require("../../src/ghost.js");

describe("requiresReply", () => {
  test.each([
    ["ok"], ["k"], ["kk"], ["okay"], ["sure"], ["yeah"],
    ["👍"], ["❤️"], ["😂"], ["lol"], ["lmao"],
    ["thanks"], ["thank you"], ["thx"], ["ty"],
    [""], ["   "],
  ])('"%s" → false (no reply needed)', (msg) => {
    expect(requiresReply(msg)).toBe(false);
  });

  test.each([
    ["hey what are you doing tonight"],
    ["are you free saturday"],
    ["can you help me with this"],
    ["what do you think about that"],
    ["did you see what happened"],
    ["yo we going out?"],
  ])('"%s" → true (reply needed)', (msg) => {
    expect(requiresReply(msg)).toBe(true);
  });
});
