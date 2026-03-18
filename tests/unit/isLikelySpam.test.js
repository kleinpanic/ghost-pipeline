const fs = require("fs");
const os = require("os");
const path = require("path");
const { isLikelySpam } = require("../../src/ghost.js");

// Each test gets a unique fake phone to avoid rate-limit state leaking between tests
let phoneCounter = 8880000;
const nextFakePhone = () => `1999555${String(phoneCounter++).slice(-4)}`;

// Clear the rate-limit file before each test to prevent cross-test contamination
const RATELIMIT_FILE = path.join(os.homedir(), ".openclaw", "data", "ghost-spam-ratelimit.json");
beforeEach(() => { try { fs.writeFileSync(RATELIMIT_FILE, "{}"); } catch {} });

describe("isLikelySpam", () => {
  test.each([
    ["CONGRATULATIONS you won $1000 click here"],
    ["verify your account immediately"],
    ["reply STOP to opt out"],
    ["your apple id has been compromised"],
    ["bank account unauthorized transaction detected"],
    ["special offer expires today call immediately"],
    ["discounted rate limited time offer"],
    ["delivery attempt failed reschedule now"],
  ])('"%s" → spam', (text) => {
    expect(isLikelySpam(nextFakePhone(), text)).toBe(true);
  });

  test.each([
    ["hey what's up"],
    ["are you coming to the party"],
    ["let me know when you're free"],
    ["did you finish the homework"],
  ])('"%s" → not spam', (text) => {
    expect(isLikelySpam(nextFakePhone(), text)).toBe(false);
  });
});
