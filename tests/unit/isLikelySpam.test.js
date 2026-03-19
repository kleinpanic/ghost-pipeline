const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { isLikelySpam } = require("../../src/ghost.js");

let phoneCounter = 8880000;
const nextFakePhone = () => `1999555${String(phoneCounter++).slice(-4)}`;

const RATELIMIT_FILE = path.join(os.homedir(), ".openclaw", "data", "ghost-spam-ratelimit.json");
beforeEach(() => { try { fs.writeFileSync(RATELIMIT_FILE, "{}"); } catch {} });

describe("isLikelySpam — is spam (→ true)", () => {
  // ── classic spam phrases ─────────────────────────────────────────────────
  test.each([
    ["CONGRATULATIONS you won $1000 click here"],
    ["verify your account immediately"],
    ["reply STOP to opt out"],
    ["reply stop to unsubscribe"],
    ["text stop to opt out"],
    ["your apple id has been compromised"],
    ["your google account has been suspended"],
    ["bank account unauthorized transaction detected"],
    ["special offer expires today call immediately"],
    ["discounted rate limited time offer"],
    ["delivery attempt failed reschedule now"],
    ["free gift claim now expires soon"],
    ["you've won a prize click here to claim"],
    ["call immediately to avoid account suspension"],
    ["unusual activity detected on your account"],
  ])('classic spam "%s" → true', (text) => {
    expect(isLikelySpam(nextFakePhone(), text)).toBe(true);
  });

  // ── discount / promo spam (NEW) ──────────────────────────────────────────
  test.each([
    ["Dude I went online and found a code for 40% off"],
    ["Use code SAVE20 for 20% off your order"],
    ["Flash sale — 50% off everything today only"],
    ["Limited offer — get 30% off while supplies last"],
    ["Exclusive deal: free shipping on all orders shop now"],
    ["Claim your reward points before they expire"],
    ["Your gift card is waiting — claim now"],
    ["No interest no fees apply now for our exclusive deal"],
    ["Order now and save with our promo code"],
    ["Get yours today — deal expires at midnight"],
    ["Buy now and save big on your first order"],
  ])('promo spam "%s" → true', (text) => {
    expect(isLikelySpam(nextFakePhone(), text)).toBe(true);
  });

  // ── short-code senders (5-6 digit numbers) ───────────────────────────────
  test("5-digit sender → spam", () => {
    expect(isLikelySpam("12345", "Your OTP is 847291")).toBe(true);
  });
  test("6-digit sender → spam", () => {
    expect(isLikelySpam("898989", "Your verification code is 1234")).toBe(true);
  });

  // ── URL from unknown sender ───────────────────────────────────────────────
  test("URL from unknown → spam", () => {
    expect(isLikelySpam(nextFakePhone(), "Click here http://sus-link.biz/abc")).toBe(true);
  });

  // ── pure numeric body (OTP spam) ────────────────────────────────────────
  test.each([["847291"], ["12345"], ["99887766"]])('numeric body "%s" → spam', (text) => {
    expect(isLikelySpam(nextFakePhone(), text)).toBe(true);
  });

  // ── ALL CAPS blast (long) ────────────────────────────────────────────────
  test("ALL CAPS long message → spam", () => {
    expect(isLikelySpam(nextFakePhone(), "HUGE SAVINGS TODAY ONLY CLICK HERE NOW BIG DEALS")).toBe(true);
  });
});

describe("isLikelySpam — NOT spam (→ false)", () => {
  test.each([
    ["hey what's up"],
    ["are you coming to the party"],
    ["let me know when you're free"],
    ["did you finish the homework"],
    ["just got back from the gym"],
    ["dude you gotta see this video"],
    ["when are you getting here"],
    ["what time works for you saturday"],
    ["yo we still on for tonight"],
    ["bro that was hilarious"],
    ["can you pick me up from campus"],
    ["hey long time no talk, how are you doing"],
    // looks promo-ish but is conversational — no keyword match
    ["I got a great deal on a used bike"],
    ["the food here is so good"],
    ["my mom said thanks for the help"],
  ])('legit message "%s" → false', (text) => {
    expect(isLikelySpam(nextFakePhone(), text)).toBe(false);
  });
});
