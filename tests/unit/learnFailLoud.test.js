/**
 * D6 / O-2 regression: `ghost learn --all --voice-profile` wrote convincing fakes.
 *
 * OpenRouter retired the `:free` variant of google/gemma-3-27b-it on 2026-08-06 and
 * began answering the slug with HTTP 404:
 *   "This model is unavailable for free. The paid version is available now -
 *    use this slug instead: google/gemma-3-27b-it"
 * tryOpenRouter collapses every failure to null, so learnContact and buildVoiceProfile
 * each substituted a hardcoded stub, stamped it with `new Date()`, and returned it as
 * if it were real analysis. cmdLearn counted the stubs as successes and exited 0.
 * Result: six consecutive nights (2026-08-07 → 2026-08-12) of stats-only contact files
 * and a two-line literal voice-profile.md — all dated fresh. Ghost drafts messages AS
 * Klein, so it was impersonating him from a constant.
 *
 * These tests pin the Option C contract: a learn run that cannot do its job must fail
 * loudly and write nothing. The fresh date is the tell that made the defect invisible,
 * so "did not write" is asserted on content AND on the Updated stamp of a pre-existing
 * file, not just on existence.
 *
 * The 404 body below is the verbatim production payload, so these tests drive the real
 * tryOpenRouter code path rather than a stubbed-out approximation of it.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const nock = require("nock");

// Redirect every module-load path constant into a temp HOME before requiring ghost.js.
// Same hermetic pattern as tests/unit/contactParser.test.js — without it these tests
// would write to the operator's live workspace-ghost/memory.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-learn-faillow-"));
process.env.HOME = tmpHome;

const GH_DIR       = path.join(tmpHome, ".openclaw", "workspace-ghost");
const MEMORY_DIR   = path.join(GH_DIR, "memory");
const CONTACTS_DIR = path.join(MEMORY_DIR, "contacts");
const VOICE_FILE   = path.join(MEMORY_DIR, "voice-profile.md");

fs.mkdirSync(CONTACTS_DIR, { recursive: true });
fs.mkdirSync(path.join(GH_DIR, "governance"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".openclaw", "data"), { recursive: true });

// tryOpenRouter short-circuits to null when the key is absent — and would then "fail"
// for the wrong reason, making these tests pass vacuously. Give it a dummy key so the
// request is actually issued and nock answers it.
fs.mkdirSync(path.join(tmpHome, ".config", "openrouter"), { recursive: true });
fs.writeFileSync(path.join(tmpHome, ".config", "openrouter", "api-key"), "sk-or-test-dummy\n");

fs.writeFileSync(
  path.join(GH_DIR, "governance", "CONTACTS.md"),
  [
    "# Test Contacts",
    "<!-- CONTACT_ALLOWLIST_START -->",
    "- Alpha | +15550000001 | ask | close_friend | test contact",
    "<!-- CONTACT_ALLOWLIST_END -->",
    "",
  ].join("\n"),
);

jest.mock("child_process", () => {
  const real = jest.requireActual("child_process");
  return { ...real, spawnSync: jest.fn() };
});
const cp    = require("child_process");
const ghost = require("../../src/ghost.js");

// The exact body OpenRouter returns for the retired slug (ghost-learn.log, 66 hits).
const RETIRED_SLUG_404 = {
  error: {
    message: "This model is unavailable for free. The paid version is available now - "
           + "use this slug instead: google/gemma-3-27b-it",
    code: 404,
  },
};

function mockOpenRouterDead() {
  return nock("https://openrouter.ai")
    .post("/api/v1/chat/completions")
    .reply(404, RETIRED_SLUG_404);
}

function mockOpenRouterAlive(text) {
  return nock("https://openrouter.ai")
    .post("/api/v1/chat/completions")
    .reply(200, { choices: [{ message: { content: text } }], usage: { total_tokens: 42 } });
}

/** Make mcporter return canned BB payloads, keyed off the tool name in argv. */
function mockMcporter({ messages }) {
  cp.spawnSync.mockImplementation((bin, args, opts) => {
    const tool = String(args[1] || "");
    let payload = {};
    if (tool.endsWith("bb_contact_query"))      payload = { contacts: [] };
    else if (tool.endsWith("bb_list_chats"))    payload = { chats: [CHAT] };
    else if (tool.endsWith("bb_get_chat_messages")) payload = { messages };
    const out = opts && Array.isArray(opts.stdio) ? opts.stdio[1] : null;
    if (typeof out === "number") fs.writeSync(out, JSON.stringify(payload));
    return { status: 0, stdout: null, stderr: "" };
  });
}

const CHAT = { guid: "iMessage;-;+15550000001", participants: ["+15550000001"] };

const KLEIN_MSGS = [
  { isFromMe: true,  text: "yea im down for that" },
  { isFromMe: true,  text: "bet lmk when youre free" },
  { isFromMe: false, text: "sounds good" },
];

// phone is digits-only: loadAllowlist stores normalizePhone(...) output, and the
// contact-memory filename is derived from it (`15550000001-alpha.md`, no leading +).
const CONTACT = { name: "Alpha", alias: "Alpha", phone: "15550000001", category: "close_friend" };

beforeEach(() => {
  cp.spawnSync.mockReset();
  nock.cleanAll();
  try { fs.unlinkSync(VOICE_FILE); } catch {}
  for (const f of fs.readdirSync(CONTACTS_DIR)) fs.unlinkSync(path.join(CONTACTS_DIR, f));
});

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("buildVoiceProfile — must not fabricate Klein's voice", () => {
  test("throws instead of writing a stub when the model is unavailable", async () => {
    mockOpenRouterDead();
    await expect(ghost.buildVoiceProfile({ Alpha: "some summary" }))
      .rejects.toThrow(/refusing to write/i);
  });

  test("writes no voice-profile.md at all when the model is unavailable", async () => {
    mockOpenRouterDead();
    await expect(ghost.buildVoiceProfile({ Alpha: "some summary" })).rejects.toThrow();
    expect(fs.existsSync(VOICE_FILE)).toBe(false);
  });

  // The defect's camouflage: the stub was stamped with today's date, so a six-day-dead
  // pipeline looked freshly generated. A failed run must not touch the stamp.
  test("does not re-stamp an existing profile with a fresh date when the model fails", async () => {
    const original = "# Klein Voice Profile\n_Updated: 2026-01-01_\n\n## Core Typography\nreal generated content\n";
    fs.writeFileSync(VOICE_FILE, original);

    mockOpenRouterDead();
    await expect(ghost.buildVoiceProfile({ Alpha: "some summary" })).rejects.toThrow();

    const after = fs.readFileSync(VOICE_FILE, "utf8");
    expect(after).toBe(original);
    expect(after).toContain("_Updated: 2026-01-01_");
    expect(after).not.toContain(new Date().toISOString().slice(0, 10));
  });

  // Boundary: zero summaries. Even a live model cannot synthesise a voice profile from
  // an empty corpus — it can only invent one, which is worse than the stub because it
  // reads as genuine analysis. Refuse before spending the call.
  test("refuses to synthesise a profile from zero contact summaries", async () => {
    const scope = mockOpenRouterAlive("## Core Typography\ninvented from nothing");
    await expect(ghost.buildVoiceProfile({})).rejects.toThrow(/no contact summaries/i);
    expect(fs.existsSync(VOICE_FILE)).toBe(false);
    expect(scope.isDone()).toBe(false); // the model was never even asked
    nock.cleanAll();
  });

  test("writes the profile when the model actually responds", async () => {
    mockOpenRouterAlive("## Core Typography\nlowercase, trailing-period-free\n\n## Response Length\nshort");
    await ghost.buildVoiceProfile({ Alpha: "some summary" });

    const written = fs.readFileSync(VOICE_FILE, "utf8");
    expect(written).toContain("trailing-period-free");
    expect(written).toContain(`_Updated: ${new Date().toISOString().slice(0, 10)}_`);
  });
});

describe("learnContact — must not write stats-only stubs", () => {
  test("throws instead of writing a stub when the model is unavailable", async () => {
    mockMcporter({ messages: KLEIN_MSGS });
    mockOpenRouterDead();

    await expect(ghost.learnContact(CONTACT, [CHAT])).rejects.toThrow(/refusing to write/i);
    expect(fs.readdirSync(CONTACTS_DIR)).toHaveLength(0);
  });

  test("leaves a previously-good contact file untouched when the model fails", async () => {
    const file = path.join(CONTACTS_DIR, "15550000001-alpha.md");
    const original = "# Contact Memory: Alpha\n_Updated: 2026-03-17_\n\n## Typical Topics\nreal generated prose\n";
    fs.writeFileSync(file, original);

    mockMcporter({ messages: KLEIN_MSGS });
    mockOpenRouterDead();

    await expect(ghost.learnContact(CONTACT, [CHAT])).rejects.toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  test("writes the summary when the model actually responds", async () => {
    mockMcporter({ messages: KLEIN_MSGS });
    mockOpenRouterAlive("## Who They Are\nAlpha is a close friend from VT.");

    const summary = await ghost.learnContact(CONTACT, [CHAT]);
    expect(summary).toContain("close friend from VT");

    const file = path.join(CONTACTS_DIR, "15550000001-alpha.md");
    expect(fs.readFileSync(file, "utf8")).toContain("close friend from VT");
  });

  // Not a model failure — genuinely nothing to analyse. Must stay a quiet skip (null),
  // otherwise a contact with no history would break the whole nightly sweep.
  test("returns null without throwing when the contact has no sent messages", async () => {
    mockMcporter({ messages: [{ isFromMe: false, text: "hey" }] });
    const result = await ghost.learnContact(CONTACT, [CHAT]);
    expect(result).toBeNull();
    expect(fs.readdirSync(CONTACTS_DIR)).toHaveLength(0);
  });
});

describe("cmdLearn — exit contract", () => {
  test("rejects (nonzero exit) when the model is dead for every contact", async () => {
    mockMcporter({ messages: KLEIN_MSGS });
    nock("https://openrouter.ai").post("/api/v1/chat/completions").times(5).reply(404, RETIRED_SLUG_404);

    // The CLI dispatcher maps a rejection to process.exit(1) (src/ghost.js:4227-4229),
    // so rejecting here IS the nonzero exit.
    await expect(ghost.cmdLearn(["--all", "--voice-profile"])).rejects.toThrow(/learn failed/i);
    expect(fs.existsSync(VOICE_FILE)).toBe(false);
    expect(fs.readdirSync(CONTACTS_DIR)).toHaveLength(0);
  }, 15000);
});
