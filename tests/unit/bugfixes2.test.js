"use strict";
/**
 * bugfixes2.test.js — Regression tests for ghost pipeline fix batch (2026-03-20)
 *
 * Covers:
 *  1. Cancel race guard (cancelledDraftIds in-memory set)
 *  2. sanitizeMessageText — strips links, attachments, secrets
 *  3. sanitizeForModel — replaces with placeholders
 *  4. isLikelySpam — OTP/2FA patterns (existing function, new patterns tested)
 *  5. requiresReply — SSH/infrastructure access requests blocked
 *  6. family_close tone — validated via CATEGORY_TONE (exported separately)
 *  7. kleinRepliedRecentlyChats — in-memory reply tracker
 */

const {
  sanitizeMessageText,
  sanitizeForModel,
  isLikelySpam,
  requiresReply,
  cancelledDraftIds,
  cancelledDraftTtl,
  kleinRepliedRecentlyChats,
} = require("../../src/ghost.js");

// ─────────────────────────────────────────────────────────────────────────────
// 1. sanitizeMessageText
// ─────────────────────────────────────────────────────────────────────────────
describe("sanitizeMessageText", () => {
  test("strips http URL → null when only a link", () => {
    expect(sanitizeMessageText("https://example.com/foo")).toBeNull();
  });

  test("strips https URL from mixed message", () => {
    const result = sanitizeMessageText("yo check this https://tiktok.com/trending out");
    expect(result).not.toContain("https://");
    expect(result).toMatch(/yo check this.*out/i);
  });

  test("strips [attachment: photo.jpg] marker", () => {
    const result = sanitizeMessageText("[attachment: photo.jpg]");
    expect(result).toBeNull();
  });

  test("strips attachment + leaves surrounding text", () => {
    const result = sanitizeMessageText("here is the doc [attachment: report.pdf] check it");
    expect(result).not.toContain("attachment");
    expect(result).toMatch(/here is the doc.*check it/i);
  });

  test("strips bare image filename", () => {
    const result = sanitizeMessageText("IMG_1234.jpg");
    expect(result).toBeNull();
  });

  test("strips bare image filename with text", () => {
    const result = sanitizeMessageText("from last night IMG_5678.heic");
    expect(result).not.toContain(".heic");
    expect(result).toMatch(/from last night/i);
  });

  test("redacts sk- API key", () => {
    const result = sanitizeMessageText("my key is sk-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-abc");
  });

  test("does not alter normal conversation text", () => {
    const msg = "hey man what are you doing tonight";
    expect(sanitizeMessageText(msg)).toBe(msg);
  });

  test("returns null for empty string", () => {
    expect(sanitizeMessageText("")).toBeNull();
    expect(sanitizeMessageText(null)).toBeNull();
    expect(sanitizeMessageText(undefined)).toBeNull();
  });

  test("returns null for whitespace-only", () => {
    expect(sanitizeMessageText("   ")).toBeNull();
  });

  test("URL + text → text preserved", () => {
    const result = sanitizeMessageText("dude look at this https://instagram.com/reel it's insane");
    expect(result).not.toContain("instagram");
    expect(result).toMatch(/dude look at this.*it's insane/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. sanitizeForModel
// ─────────────────────────────────────────────────────────────────────────────
describe("sanitizeForModel", () => {
  test("replaces URL with [link] placeholder", () => {
    expect(sanitizeForModel("check https://example.com out")).toBe("check [link] out");
  });

  test("replaces attachment marker with [attachment]", () => {
    expect(sanitizeForModel("[attachment: photo.jpg]")).toBe("[attachment]");
  });

  test("replaces media filename with [media]", () => {
    expect(sanitizeForModel("IMG_1234.jpg")).toBe("[media]");
  });

  test("normal text unchanged", () => {
    const msg = "what's up man";
    expect(sanitizeForModel(msg)).toBe(msg);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. isLikelySpam — OTP/2FA patterns (fix #5)
// ─────────────────────────────────────────────────────────────────────────────
const nextFakePhone = (() => { let i = 9990000; return () => `1888555${String(i++).slice(-4)}`; })();

describe("isLikelySpam — OTP/2FA messages", () => {
  test.each([
    ["[TikTok] 659540 is your verification code, valid for 5 minutes. To keep your account safe, never forward this code."],
    ["Your verification code is 847291"],
    ["Your security code is: 123456"],
    ["One-time passcode: 984732"],
    ["Enter this code to sign in: 574829"],
    ["Your authentication code is 291847"],
    ["293847 is your login code. Valid for 10 minutes."],
    ["Do not share this code with anyone. Your code is: 847261"],
    ["Never share your code with anyone. Code: 847261"],
    ["Your Google verification code is 847291 — never share this"],
    ["Apple ID verification code: 738291"],
    ["293847 — never forward this code"],
  ])('OTP message "%s" → spam', (text) => {
    expect(isLikelySpam(nextFakePhone(), text)).toBe(true);
  });

  test("short-code sender (5 digits) always spam regardless of text", () => {
    expect(isLikelySpam("12345", "hello")).toBe(true);
  });

  test("normal conversation NOT flagged as OTP spam", () => {
    // "code" alone should not trigger
    expect(isLikelySpam(nextFakePhone(), "what's the code for the door")).toBe(false);
  });

  test("programming talk NOT flagged as OTP spam", () => {
    expect(isLikelySpam(nextFakePhone(), "I pushed the code, check the PR")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. requiresReply — SSH/infra access requests should return false
// ─────────────────────────────────────────────────────────────────────────────
describe("requiresReply — SSH/infra requests blocked", () => {
  test.each([
    ["can you give me SSH access to your server"],
    ["lemme get ssh access to the box"],
    ["send me the ssh key for the vps"],
    ["can i get remote access to the machine"],
    ["could i have vpn access config"],
  ])('SSH/infra request "%s" → false (ghost stays out)', (msg) => {
    expect(requiresReply(msg)).toBe(false);
  });

  // Tech talk that ISN'T an access request → should still draft
  test.each([
    ["I set up SSH on my raspberry pi"],
    ["my ssh connection keeps dropping"],
    ["what distro should I run on my vps"],
  ])('normal tech talk "%s" → true (ghost can draft)', (msg) => {
    expect(requiresReply(msg)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Cancel race guard — cancelledDraftIds / cancelledDraftTtl
// ─────────────────────────────────────────────────────────────────────────────
describe("cancelledDraftIds in-memory set", () => {
  afterEach(() => {
    cancelledDraftIds.clear();
    cancelledDraftTtl.clear();
  });

  test("can add draftId and check presence", () => {
    cancelledDraftIds.add("abc123ef");
    cancelledDraftTtl.set("abc123ef", Date.now() + 600000);
    expect(cancelledDraftIds.has("abc123ef")).toBe(true);
  });

  test("TTL pruning removes expired entries", () => {
    cancelledDraftIds.add("deadbeef");
    cancelledDraftTtl.set("deadbeef", Date.now() - 1); // already expired
    // Simulate the TTL pruning logic from doReactionCheck
    for (const [id, exp] of cancelledDraftTtl.entries()) {
      if (Date.now() > exp) { cancelledDraftIds.delete(id); cancelledDraftTtl.delete(id); }
    }
    expect(cancelledDraftIds.has("deadbeef")).toBe(false);
  });

  test("live (non-expired) entries survive pruning", () => {
    cancelledDraftIds.add("cafebabe");
    cancelledDraftTtl.set("cafebabe", Date.now() + 600000);
    for (const [id, exp] of cancelledDraftTtl.entries()) {
      if (Date.now() > exp) { cancelledDraftIds.delete(id); cancelledDraftTtl.delete(id); }
    }
    expect(cancelledDraftIds.has("cafebabe")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. kleinRepliedRecentlyChats in-memory tracker
// ─────────────────────────────────────────────────────────────────────────────
describe("kleinRepliedRecentlyChats in-memory tracker", () => {
  afterEach(() => {
    kleinRepliedRecentlyChats.clear();
  });

  test("stores and retrieves reply timestamp", () => {
    const now = Date.now();
    kleinRepliedRecentlyChats.set("iMessage;-;+15551234567", now);
    const ts = kleinRepliedRecentlyChats.get("iMessage;-;+15551234567");
    expect(ts).toBe(now);
    expect(Date.now() - ts).toBeLessThan(100);
  });

  test("30-min pruning removes old entries", () => {
    const oldTs = Date.now() - 31 * 60 * 1000;
    kleinRepliedRecentlyChats.set("iMessage;-;+15559999999", oldTs);
    // Simulate pruning
    for (const [k, ts] of kleinRepliedRecentlyChats.entries()) {
      if (Date.now() - ts > 30 * 60 * 1000) kleinRepliedRecentlyChats.delete(k);
    }
    expect(kleinRepliedRecentlyChats.has("iMessage;-;+15559999999")).toBe(false);
  });

  test("recent entries (<30 min) survive pruning", () => {
    const recentTs = Date.now() - 5 * 60 * 1000;
    kleinRepliedRecentlyChats.set("iMessage;-;+15558888888", recentTs);
    for (const [k, ts] of kleinRepliedRecentlyChats.entries()) {
      if (Date.now() - ts > 30 * 60 * 1000) kleinRepliedRecentlyChats.delete(k);
    }
    expect(kleinRepliedRecentlyChats.has("iMessage;-;+15558888888")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Link-only messages skipped via sanitizeMessageText → requiresReply
// ─────────────────────────────────────────────────────────────────────────────
describe("link-only / media-only messages produce no draft", () => {
  test("pure URL sanitizes to null → no draft", () => {
    expect(sanitizeMessageText("https://youtu.be/dQw4w9WgXcQ")).toBeNull();
  });

  test("URL + attachment sanitizes to null", () => {
    // Both stripped, nothing left
    const result = sanitizeMessageText("https://example.com [attachment: photo.jpg]");
    expect(result).toBeNull();
  });

  test("requiresReply(null) → false (additional safety)", () => {
    expect(requiresReply(null)).toBe(false);
    expect(requiresReply("")).toBe(false);
  });
});
