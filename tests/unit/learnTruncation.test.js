/**
 * D6 / O-2 cycle 2: the fail-loud guard shipped in 4752184 rejects an EMPTY model
 * response. It does not reject a TRUNCATED one — and a truncated document is the more
 * dangerous of the two, because it still looks like the real artifact.
 *
 * `tryOpenRouter` hardcoded `max_tokens: 200`. That is correct for the draft path, which
 * produces a two-line text reply. The voice-profile prompt asks for SEVEN `##` sections
 * and the contact prompt for six; neither fits in 200 tokens. So the moment learn was
 * repointed at a live model it would have started writing profiles cut off mid-sentence,
 * stamped with a fresh date, and the emptiness guard would have passed them — the exact
 * defect class cycle 1 just closed, re-entering through a different door.
 *
 * Two things are therefore pinned here:
 *   1. the token budget is PER-CALL — learn gets a large one, the draft path keeps 200
 *      (OR) and 300 (Spark). A global bump would have made every draft 6x more expensive
 *      and is the obvious wrong fix.
 *   2. a response that is cut off (`finish_reason: "length"`) or that carries fewer
 *      sections than the prompt requested is a FAILURE, not a degraded success.
 *
 * The 503 body used for the dead-model case is the verbatim payload Spark's router
 * returned on 2026-08-13, so these tests drive the real trySparkVllm path rather than a
 * stubbed approximation of it.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const nock = require("nock");

// Same hermetic pattern as learnFailLoud.test.js — redirect every module-load path
// constant into a temp HOME before requiring ghost.js, or these tests write into the
// operator's live workspace-ghost/memory.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-learn-trunc-"));
process.env.HOME = tmpHome;

// Point Spark at a host nock can intercept. Without this the constant resolves from the
// project .env and the tests would either hit the real DGX or fail for the wrong reason.
process.env.SPARK_BASE_URL = "http://spark.test:18080/v1";
// ghost reads ~/.openclaw/.spark-key first and falls back to env(). Under tmpHome the
// key file is absent, and env() would otherwise resolve the OPERATOR'S REAL TOKEN out of
// the project .env. Force a dummy so no real credential is ever put on the wire.
process.env.SPARK_API_KEY = "spark-test-dummy";

const SPARK_ORIGIN = "http://spark.test:18080";
const SPARK_PATH   = "/v1/chat/completions";

const GH_DIR       = path.join(tmpHome, ".openclaw", "workspace-ghost");
const MEMORY_DIR   = path.join(GH_DIR, "memory");
const CONTACTS_DIR = path.join(MEMORY_DIR, "contacts");
const VOICE_FILE   = path.join(MEMORY_DIR, "voice-profile.md");

fs.mkdirSync(CONTACTS_DIR, { recursive: true });
fs.mkdirSync(path.join(GH_DIR, "governance"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, ".openclaw", "data"), { recursive: true });

// OPENROUTER_API_KEY is resolved once at module load, so this must exist before the
// require below — written inside a test it would be too late and tryOpenRouter would
// short-circuit to null, making the budget assertion pass vacuously.
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

const ghost = require("../../src/ghost.js");

// imsg chats.list row (NAT-25): the id is what messages.history takes.
const CHAT = { id: 1, guid: "iMessage;-;+15550000001", identifier: "+15550000001" };
const CONTACT = { name: "Alpha", alias: "Alpha", phone: "15550000001", category: "close_friend" };
const KLEIN_MSGS = [
  { isFromMe: true,  text: "yea im down for that" },
  { isFromMe: true,  text: "bet lmk when youre free" },
  { isFromMe: false, text: "sounds good" },
];

function mockImsg({ messages }) {
  // imsg rpc answers with raw payloads; ghost normalizes them (is_from_me → isFromMe).
  ghost.setTransport({
    imsgRequest: async (method, params) => {
      if (method === "chats.list") return { chats: [CHAT] };
      if (method === "messages.history" && params.chat_id === CHAT.id) {
        return { messages: messages.map(m => ({ is_from_me: m.isFromMe === true, text: m.text })) };
      }
      return {};
    },
  });
}

/** Spark answers with `text`, reporting why it stopped. */
function mockSpark(text, finishReason = "stop") {
  return nock(SPARK_ORIGIN)
    .post(SPARK_PATH)
    .reply(200, {
      model: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
      choices: [{ message: { content: text }, finish_reason: finishReason }],
    });
}

/** Build a document with `n` `##` sections, so section-count is controlled exactly. */
function sections(n, body = "content") {
  return Array.from({ length: n }, (_, i) => `## Section ${i + 1}\n${body}`).join("\n\n");
}

/** A complete, well-formed voice profile: the 7 headings the prompt actually asks for. */
const FULL_PROFILE = [
  "## Core Typography\nlowercase, no trailing period",
  "## Universal Vocabulary\nyea, bet, fs",
  "## Response Length\nshort unless making plans",
  "## What Klein Knows / Talks About\nVT, embedded systems, linux",
  "## How He Deflects\ngoes vague and changes subject",
  "## Current Life Context\nVT student, mid-semester",
  "## What Immediately Sounds Like Klein\nno caps, 'bet', dry humor",
].join("\n\n");

/** A complete contact summary: the 6 headings that prompt asks for. */
const FULL_SUMMARY = [
  "## Who They Are\nAlpha is a close friend from VT.",
  "## Typical Topics\nplans, classes",
  "## Klein's Tone With Them\nrelaxed, lowercase",
  "## Running Threads\nweekend plans",
  "## Sample Klein Messages\nyea im down",
  "## Reply Guidelines\nkeep it under 15 words",
].join("\n\n");

beforeEach(() => {
  ghost.setTransport({ imsgRequest: async () => { throw new Error("imsg not mocked"); } });
  nock.cleanAll();
  try { fs.unlinkSync(VOICE_FILE); } catch {}
  for (const f of fs.readdirSync(CONTACTS_DIR)) fs.unlinkSync(path.join(CONTACTS_DIR, f));
});

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

// ── 1. The budget is per-call ────────────────────────────────────────────────
// A global bump would silently make every draft 6x more expensive. These pin the
// draft defaults so that can't happen without a test going red.

describe("token budget is per-call, not global", () => {
  test("trySparkVllm defaults to the 300-token draft budget", async () => {
    let sent = null;
    nock(SPARK_ORIGIN).post(SPARK_PATH, body => { sent = body; return true; })
      .reply(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });

    await ghost.trySparkVllm("any", "sys", "user");
    expect(sent.max_tokens).toBe(300);
  });

  test("trySparkVllm honours a caller-supplied budget", async () => {
    let sent = null;
    nock(SPARK_ORIGIN).post(SPARK_PATH, body => { sent = body; return true; })
      .reply(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });

    await ghost.trySparkVllm("any", "sys", "user", 15000, 1200);
    expect(sent.max_tokens).toBe(1200);
  });

  test("tryOpenRouter still defaults to the 200-token draft budget", async () => {
    let sent = null;
    nock("https://openrouter.ai").post("/api/v1/chat/completions", body => { sent = body; return true; })
      .reply(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });

    await ghost.tryOpenRouter("some/model", "sys", "user");
    expect(sent.max_tokens).toBe(200);
  });

  // Without this, hardcoding 200 back into tryOpenRouter passes every other test in this
  // file — the default assertion above cannot tell a respected parameter from an ignored
  // one. Caught by mutation testing, 2026-08-13.
  test("tryOpenRouter honours a caller-supplied budget", async () => {
    let sent = null;
    nock("https://openrouter.ai").post("/api/v1/chat/completions", body => { sent = body; return true; })
      .reply(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });

    await ghost.tryOpenRouter("some/model", "sys", "user", 20000, 1500);
    expect(sent.max_tokens).toBe(1500);
  });

  test("learn asks for a budget large enough to hold a full profile", async () => {
    let sent = null;
    nock(SPARK_ORIGIN).post(SPARK_PATH, body => { sent = body; return true; })
      .reply(200, { choices: [{ message: { content: FULL_PROFILE }, finish_reason: "stop" }] });

    await ghost.buildVoiceProfile({ Alpha: "some summary" });
    expect(sent.max_tokens).toBe(ghost.LEARN_MAX_TOKENS);
    expect(ghost.LEARN_MAX_TOKENS).toBeGreaterThanOrEqual(1000);
  });
});

// ── 2. Truncation is a failure ───────────────────────────────────────────────

describe("buildVoiceProfile — a cut-off profile is not a profile", () => {
  test("throws when the model hit the token ceiling mid-document", async () => {
    mockSpark(FULL_PROFILE.slice(0, 200), "length");
    await expect(ghost.buildVoiceProfile({ Alpha: "some summary" }))
      .rejects.toThrow(/truncat/i);
  });

  test("writes nothing when the response was truncated", async () => {
    mockSpark(FULL_PROFILE.slice(0, 200), "length");
    await expect(ghost.buildVoiceProfile({ Alpha: "some summary" })).rejects.toThrow();
    expect(fs.existsSync(VOICE_FILE)).toBe(false);
  });

  // The camouflage that hid the original defect was the fresh date. A truncated run must
  // not re-stamp a good older profile any more than a failed one may.
  test("does not re-stamp an existing good profile when truncated", async () => {
    const original = "# Klein Voice Profile\n_Updated: 2026-01-01_\n\n## Core Typography\nreal content\n";
    fs.writeFileSync(VOICE_FILE, original);

    mockSpark(FULL_PROFILE.slice(0, 200), "length");
    await expect(ghost.buildVoiceProfile({ Alpha: "some summary" })).rejects.toThrow();

    expect(fs.readFileSync(VOICE_FILE, "utf8")).toBe(original);
  });

  // finish_reason is the provider's own signal and providers do not always set it.
  // The section count is the independent oracle: the prompt asks for 7 headings, so
  // fewer than 7 means the document is incomplete regardless of what the API claims.
  test("throws when the model stopped cleanly but produced too few sections", async () => {
    mockSpark(sections(3), "stop");
    await expect(ghost.buildVoiceProfile({ Alpha: "some summary" }))
      .rejects.toThrow(/section/i);
  });

  // Boundary: exactly one section short. The single reported failure is never the only
  // one worth testing — off-by-one at the equivalence-class edge is where guards leak.
  test("throws at one section short of complete", async () => {
    mockSpark(sections(6), "stop");
    await expect(ghost.buildVoiceProfile({ Alpha: "some summary" }))
      .rejects.toThrow(/section/i);
  });

  test("accepts exactly the requested number of sections", async () => {
    const scope = mockSpark(FULL_PROFILE, "stop");
    await ghost.buildVoiceProfile({ Alpha: "some summary" });

    expect(scope.isDone()).toBe(true);
    const written = fs.readFileSync(VOICE_FILE, "utf8");
    expect(written).toContain("What Immediately Sounds Like Klein");
    expect(written).toContain(`_Updated: ${new Date().toISOString().slice(0, 10)}_`);
  });

  test("accepts a model that returns more sections than requested", async () => {
    mockSpark(`${FULL_PROFILE}\n\n## Extra Notes\nbonus`, "stop");
    await ghost.buildVoiceProfile({ Alpha: "some summary" });
    expect(fs.readFileSync(VOICE_FILE, "utf8")).toContain("Extra Notes");
  });
});

// The prompt shows `## Heading`, but that is a suggestion to a language model, not a
// contract. Nemotron answers this exact prompt with `### **Heading**` — verified live on
// 2026-08-13, a complete 7-section 6.8KB profile. A guard keyed to the literal `## `
// would have rejected that good document every night and stopped the pipeline for a
// formatting preference, which is a false alarm, not safety. What the guard must detect
// is a document that STOPPED EARLY — so headings are counted by role, not by syntax.
describe("completeness is judged on structure, not on one heading syntax", () => {
  const h3Bold = (titles) => titles.map(t => `### **${t}**\ncontent here`).join("\n\n");
  const PROFILE_TITLES = [
    "Core Typography", "Universal Vocabulary", "Response Length",
    "What Klein Knows / Talks About", "How He Deflects",
    "Current Life Context", "What Immediately Sounds Like Klein",
  ];

  test("accepts the ### **Bold** shape the live model actually returns", async () => {
    mockSpark(h3Bold(PROFILE_TITLES), "stop");
    await ghost.buildVoiceProfile({ Alpha: "some summary" });
    expect(fs.readFileSync(VOICE_FILE, "utf8")).toContain("What Immediately Sounds Like Klein");
  });

  // Tolerating the style must not cost the guard its teeth: the same syntax, cut short,
  // still has to fail.
  test("still rejects that same shape when it stops early", async () => {
    mockSpark(h3Bold(PROFILE_TITLES.slice(0, 4)), "stop");
    await expect(ghost.buildVoiceProfile({ Alpha: "some summary" }))
      .rejects.toThrow(/4 of 7 requested sections/);
  });

  test("accepts bold-only lines used as headings", async () => {
    mockSpark(PROFILE_TITLES.map(t => `**${t}**\ncontent`).join("\n\n"), "stop");
    await ghost.buildVoiceProfile({ Alpha: "some summary" });
    expect(fs.existsSync(VOICE_FILE)).toBe(true);
  });

  // Prose with no structure at all is not a profile, whatever its length.
  test("rejects an unstructured wall of prose", async () => {
    mockSpark("klein writes in lowercase and uses slang. ".repeat(40), "stop");
    await expect(ghost.buildVoiceProfile({ Alpha: "some summary" }))
      .rejects.toThrow(/0 of 7 requested sections/);
  });

  // The rejection has to say what it saw. "Incomplete" alone cannot distinguish a
  // truncated document from a differently-formatted one, and those need opposite fixes —
  // that ambiguity cost a diagnostic round-trip on 2026-08-13.
  test("names what it actually received when rejecting", async () => {
    mockSpark("some unstructured output that is not a profile", "stop");
    await expect(ghost.buildVoiceProfile({ Alpha: "some summary" }))
      .rejects.toThrow(/some unstructured output/);
  });
});

describe("learnContact — a cut-off summary is not a summary", () => {
  test("throws when the contact summary was truncated", async () => {
    mockImsg({ messages: KLEIN_MSGS });
    mockSpark(FULL_SUMMARY.slice(0, 120), "length");

    await expect(ghost.learnContact(CONTACT, [CHAT])).rejects.toThrow(/truncat/i);
    expect(fs.readdirSync(CONTACTS_DIR)).toHaveLength(0);
  });

  test("throws when the contact summary is missing sections", async () => {
    mockImsg({ messages: KLEIN_MSGS });
    mockSpark(sections(2), "stop");

    await expect(ghost.learnContact(CONTACT, [CHAT])).rejects.toThrow(/section/i);
    expect(fs.readdirSync(CONTACTS_DIR)).toHaveLength(0);
  });

  // This is the shape of the ACTUAL stub the pipeline wrote for six nights: two headings,
  // "Who They Are" and "Sample Klein Messages". Even if something reintroduced it, the
  // section guard now rejects it independently of the emptiness guard.
  test("rejects the historical two-section stub shape", async () => {
    mockImsg({ messages: KLEIN_MSGS });
    mockSpark("## Who They Are\nAlpha (Alpha)\n\n## Sample Klein Messages\nyea im down", "stop");

    await expect(ghost.learnContact(CONTACT, [CHAT])).rejects.toThrow(/section/i);
    expect(fs.readdirSync(CONTACTS_DIR)).toHaveLength(0);
  });

  test("writes a complete summary through", async () => {
    mockImsg({ messages: KLEIN_MSGS });
    const scope = mockSpark(FULL_SUMMARY, "stop");

    const summary = await ghost.learnContact(CONTACT, [CHAT]);
    expect(scope.isDone()).toBe(true);
    expect(summary).toContain("close friend from VT");
    expect(fs.readFileSync(path.join(CONTACTS_DIR, "15550000001-alpha.md"), "utf8"))
      .toContain("Reply Guidelines");
  });
});
