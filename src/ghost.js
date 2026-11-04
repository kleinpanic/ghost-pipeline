#!/usr/bin/env node
/**
 * ghost.js — Unified Ghost iMessage Pipeline v3 — native OpenClaw imessage transport (NAT-25, 2026-11-04)
 *
 * Usage:
 *   ghost serve                       watch iMessage (imsg rpc) + local health server
 *   ghost learn [--all]               build/update contact memories + voice profile
 *   ghost learn --contact <phone>     process one contact only
 *   ghost status                      show current state
 *   ghost pause [--hours N]           pause ghost (optional duration)
 *   ghost pause [--until ISO]         pause until timestamp
 *   ghost resume                      resume ghost
 *
 * Loop: imsg rpc inbound → preflight gates → draft → native approval card (Allow Once /
 * Deny) → send chokepoint → openclaw message send --channel imessage. Transport details
 * live in src/imsg.js.
 */

"use strict";

const http   = require("http");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const imsg   = require("./imsg");

// sqlite-vec embedding DB (lazy-initialized on first use)
let _memoriesDb = null;

// ═══════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const HOME      = process.env.HOME || "/home/broklein";
const GHOST_DIR = path.join(HOME, ".openclaw", "workspace-ghost");
const DATA_DIR  = path.join(HOME, ".openclaw", "data");

// Files
const CONTACTS_FILE       = path.join(GHOST_DIR, "governance", "CONTACTS.md");
const DENYLIST_FILE       = path.join(DATA_DIR, "ghost-denylist.json");
const PENDING_DRAFTS_FILE = path.join(DATA_DIR, "ghost-pending-drafts.json");
// Separate registry for OC-managed button shortIds (object format, keyed by shortId)
const PAUSE_FILE          = path.join(DATA_DIR, "ghost-paused.json");
// 90-03 (GHOST-TOGGLE): master send switch state. Fail-closed — absence means OFF.
const SEND_TOGGLE_FILE    = path.join(DATA_DIR, "ghost-send-enabled.json");
const SOUL_FILE           = path.join(GHOST_DIR, "SOUL.md");
const VOICE_PROFILE_FILE  = path.join(GHOST_DIR, "memory", "voice-profile.md");
const CONTACTS_MEMORY_DIR = path.join(GHOST_DIR, "memory", "contacts");
const SPAM_LOG_FILE       = path.join(DATA_DIR, "ghost-spam-log.json");
const SPAM_RATELIMIT_FILE = path.join(DATA_DIR, "ghost-spam-ratelimit.json");
const FEEDBACK_FILE       = path.join(DATA_DIR, "ghost-feedback.json");
const OUTBOUND_RATE_FILE  = path.join(DATA_DIR, "ghost-outbound-rate.json");
const OUTBOUND_BACKOFF_FILE = path.join(DATA_DIR, "ghost-outbound-backoff.json");
const EVENT_DEDUP_FILE    = path.join(DATA_DIR, "ghost-event-dedup.json");
// imsg watch.subscribe resume point (last rowid seen)
const IMSG_CURSOR_FILE    = path.join(DATA_DIR, "ghost-imsg-cursor.json");

// Per-contact send lock — prevents concurrent sends to the same contact
const sendLocks = new Map();

// Embeddings + memories DB
const GHOST_MEMORIES_DB   = path.join(DATA_DIR, "ghost-memories.db");
const GHOST_CONV_STATE_FILE = path.join(DATA_DIR, "ghost-conv-state.json");

// ── In-memory race-condition guards ─────────────────────────────────────────
// A draft cancelled while its approval card is still live (Klein replied by hand)
const cancelledDraftIds = new Set();
const cancelledDraftTtl = new Map(); // draftId → expiryMs

// Klein's own recent replies, checked before every send
const kleinRepliedRecentlyChats = new Map(); // chatGuid|phone → lastReplyMs

// Per-phone alert counter — caps unknown-contact spam at 3 alerts, then auto-deny
const unknownAlertCounts = new Map(); // normalized phone → count

// ── Embedding provider ───────────────────────────────────────────────────
const EMBED_PROVIDER = "google";
const EMBED_MODEL    = "gemini-embedding-001";  // free, 3072 dims (text-embedding-004 not on this key)
const EMBED_DIMS     = 3072;

// ── Variable cooldown constants ──────────────────────────────────────────
const COOLDOWN_STRANGER_MIN_MS   = 3.5 * 60 * 1000;
const COOLDOWN_STRANGER_MAX_MS   = 7.5 * 60 * 1000;
const COOLDOWN_ACTIVE_MIN_MS     = 1.5 * 60 * 1000;
const COOLDOWN_ACTIVE_MAX_MS     = 3.5 * 60 * 1000;
const ACTIVE_EXCHANGE_THRESHOLD  = 3;
const ACTIVE_TIMEOUT_MS          = 5  * 60 * 1000;
// Fixed cooldown per relationship tier (returned deterministically for non-active contacts)
const CATEGORY_AUTO_SEND_MS = {
  family_close:  COOLDOWN_ACTIVE_MIN_MS,          // closest — fastest
  close_friend:  COOLDOWN_ACTIVE_MIN_MS,
  friend:        Math.round((COOLDOWN_STRANGER_MIN_MS + COOLDOWN_STRANGER_MAX_MS) / 2), // 5.5 min midpoint
  acquaintance:  COOLDOWN_STRANGER_MAX_MS,          // most cautious — longest
};

// ── Content safety patterns (checked on every draft before returning) ────
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;  // CJK characters — never send Chinese/Japanese/Korean
// Commitment patterns — Ghost must NEVER send replies that obligate Klein
// to a specific time, place, or event.
//
// Split into two tiers:
//   HARD_COMMITMENT_PATTERNS  — always blocked, unambiguously scheduling
//   SOFT_COMMITMENT_PATTERNS  — only blocked when SCHEDULING_CONTEXT is also present
//
// This avoids false positives on casual responses ("that works", "sure I can check that")
// while still catching real plan-confirmations ("I'll be there at 8", "that works, dinner Friday").

// Scheduling context keywords — if any appear in the draft, apply soft commitment checks too
const SCHEDULING_CONTEXT = /\b(dinner|lunch|breakfast|brunch|meet(ing)?|hang(ing|s|out)?|come\s+over|party|event|plans?|tonight|tomorrow|this\s+(weekend|week|morning|afternoon|evening)|sunday|monday|tuesday|wednesday|thursday|friday|saturday|\d{1,2}(:\d{2})?\s*(am|pm)|o'clock)\b/i;

// Always block — these are unambiguous commitments regardless of surrounding context
const HARD_COMMITMENT_PATTERNS = [
  // "I'll be there / I will show up" — no ambiguity
  /\bi('ll| will)\s+(be there|show up)\b/i,
  // "count me in" — always an explicit RSVP
  /\bcount\s+me\s+in\b/i,
  // "see you [at/tonight/tomorrow/day]" — explicit future meetup confirmation
  /\bsee\s+you\s+(then|there|at|tonight|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
  // "we're on / we're set" — plan confirmed
  /\bwe('re| are)\s+(on|set)\b/i,
  // "sounds good, see you at 8" — scheduling-anchored agreement
  /\bsounds\s+(good|great|perfect|like\s+a\s+plan)[^.!?]*\b(see you|at \d|tonight|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
];

// Block ONLY when SCHEDULING_CONTEXT is also present in the draft —
// these phrases are fine in normal conversation but dangerous in scheduling context
const SOFT_COMMITMENT_PATTERNS = [
  // "I'll come / make it / join / attend / swing by" — commitment if scheduling context present
  /\bi('ll| will)\s+(come|make it|join|attend|come over|swing by|stop by)\b/i,
  // "I'm in" — could mean anything casually, but in scheduling context it's an RSVP
  /\bi('m| am)\s+in\b/i,
  // "works for me" / "that works" — fine as casual agreement, dangerous in scheduling context
  /\bworks?\s+for\s+me\b/i,
  /\bthat\s+works?\b/i,
  // "I can make it / be there / come" — commitment if scheduling context present
  /\bi\s+can\s+(make\s+it|be\s+there|come)\b/i,
  // "yeah/sure/definitely I'll/let's" — follow-through phrases, only block in scheduling context
  /\b(yes|yeah|yep|sure|absolutely|definitely|for\s+sure)[,!.]?\s*(i'll|i\s+will|i\s+can|let's)\b/i,
];

const NEVER_SAY = [
  /\bn[-*]+w+er\b/i,
  /\bf[-*]+ck\s+you\b/i,
  /\bkill\s+yourself\b/i,
  /\byou\s+(should\s+)?die\b/i,
  /\bi\s+(will\s+)?find\s+you\b/i,
  /\byour\s+(address|location|home)/i,
  /\bsocial\s+security\b/i,
  /\bcredit\s+card\b/i,
  /\bpassword\b/i,
  /\bsend\s+me\s+money\b/i,
  /\bwire\s+transfer\b/i,
  CJK_PATTERN,  // CJK characters — never send Chinese/Japanese/Korean
  // Identity reveals — if the model admits it's AI despite the system prompt, block it
  /\bi\s*'?m\s+(an?\s+)?(ai|artificial intelligence|language model|chatbot|bot|llm)\b/i,
  /\bi\s+am\s+(an?\s+)?(ai|artificial intelligence|language model|chatbot|bot|llm)\b/i,
  /\bas\s+an?\s+(ai|artificial intelligence|language model)\b/i,
  /\bmy\s+(creator|developer|programmer)\s+(is|was)\b/i,
  /\b(openai|anthropic|google|meta)\s+(made|created|trained|built)\s+me\b/i,
  /\bi\s+was\s+(trained|programmed|created)\s+by\b/i,
  /\bi\s+don'?t\s+(actually\s+)?have\s+(real\s+)?(feelings|emotions|consciousness)\s+(like|because|since)\s+(humans?|people|you)\b/i,
  /\bgodmode[\s:]*enabled/i,    // L1B3RT4S output signature
  /\bsure,?\s+here\s+you\s+are\s+my\s+fren/i,  // L1B3RT4S output signature
];

// Secrets
const OPENROUTER_API_KEY = readSecret(path.join(HOME, ".config", "openrouter", "api-key"));
const DISCORD_BOT_TOKEN  = readSecret(path.join(HOME, ".config", "discord", "bot-token"));

// GEMINI_API_KEY — loaded from env or .env file
/**
 * Load env vars from a specific .env file.
 * SECURITY: only call with trusted paths (project .env or ~/.openclaw/.env).
 * Never call with user-supplied paths or shell RC files (.zshenv, .bashrc, etc.).
 */
function loadEnvFile(filename) {
  try {
    const envPath = path.isAbsolute(filename) ? filename : path.join(HOME, ".openclaw", filename);
    // Safeguard: refuse to read shell RC/profile files that may contain unrelated secrets
    const base = path.basename(envPath);
    if ([".zshenv", ".zshrc", ".bashrc", ".bash_profile", ".profile", ".zprofile"].includes(base)) {
      log(`loadEnvFile: refused to read shell RC file: ${envPath}`);
      return {};
    }
    const raw = fs.readFileSync(envPath, "utf8");
    const result = {};
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m) result[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return result;
  } catch { return {}; }
}
// Gemini key: check process.env, project .env, then fallback to ~/.openclaw/.env
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || loadEnvFile(path.join(__dirname, "..", ".env")).GEMINI_API_KEY || loadEnvFile(".env").GEMINI_API_KEY || "";

// Network
// All configurable via .env or environment variables — no hardcoded personal data
const _env = loadEnvFile(path.join(__dirname, "..", ".env"));
const env = (key, fallback = "") => process.env[key] || _env[key] || fallback;

const PORT    = parseInt(env("GHOST_PORT", "18790"));
// Interface the local health server binds to. Nothing posts to ghost from another host
// since the BlueBubbles webhook was removed (NAT-25), so loopback is the default.
const BIND_HOST = env("GHOST_BIND_HOST", "127.0.0.1");
// Shared secret for the HTTP API. When set, non-loopback callers may read /pending with it.
// Sent as "Authorization: Bearer <t>", "X-Ghost-Token: <t>", or "?token=<t>".
const GHOST_API_TOKEN = env("GHOST_API_TOKEN");

// Discord
const GHOST_CHANNEL = env("GHOST_CHANNEL_ID");


// Identity
const OWNER_PHONE_NORMALIZED = env("OWNER_PHONE");

// Timing
const DRAFT_DELAY_MS          = 30 * 1000;        // generate draft 30s after message (debounce)
const AUTO_SEND_WINDOW_MS     = 5  * 60 * 1000;  // approval window: an unanswered draft expires unsent

const QUIET_HOUR_START        = 23;
const QUIET_HOUR_END          = 8;
const FAMILY_QUIET_HOUR_START = 22; // family_close + acquaintance quiet at 10pm

// Relationship category → tone guidance injected into every system prompt
const CATEGORY_TONE = {
  family_close: `
## Relationship Context: Immediate Family
- Keep replies SHORT — under ~40 characters when possible. One thought per message.
- Warm but minimal. Acknowledge what they said, don't over-explain.
- Use: "yeah", "idk", "rlly", "tn", "bc", "omg" — keep it casual but never crude.
- DO NOT use: "bruh", "lmfao", "nigga", "bet", "fr", "lowkey", "say less", "fs", "fam", "no cap", "finna", "bussin", "it's giving", heavy slang, or crude phrases.
- Treat family like close family, NOT like a friend group. Warm and casual but never street slang.
- Capital I — Klein does not lowercase his first-person pronoun with family.
- High emotional sensitivity — mirror their energy briefly. If venting, sympathize and move on.
- Never initiate new topics. Just respond to what they said.`,

  close_friend: `
## Relationship Context: Close Friend
- Full Klein energy. Fragmented rapid-fire messages — split anything over ~12 words into 2 texts.
- All slang is on the table: "bruh", "lmfao", "lowkey", "bet", "fs", "wild", "we cooked".
- Technical jargon absolutely fine if they're a tech peer.
- Match their energy exactly — if they're hype, match it; if low-key, chill out.
- Minimal punctuation. Lowercase everything except I.`,

  friend: `
## Relationship Context: Friend
- Casual Klein, slightly more composed than close friends.
- Common slang fine ("lowkey", "lmao", "idk", "bet") — heavy crude slang rare.
- Warmer and less clipped than close friends. Slightly more considered replies.
- Still brief. Split if over ~15 words.`,

  acquaintance: `
## Relationship Context: Acquaintance
- Polite-casual. Lowercase, minimal punctuation, brief.
- No crude slang. Standard friendly-but-not-overly-familiar tone.
- Keep it to the point. Don't initiate personal topics.`,
};

// ── Phase 2: Spark vllm (local DGX, reached over the wg-nvidia plane)
// The address is 10.88.88.1, NOT 10.99.1.1. `ip route get 10.88.88.1` leaves via
// `dev wg-nvidia`; 10.99.1.1 has no route onto that plane and falls through to the LAN
// gateway, where nothing listens. Both addresses were floating around as "the Spark
// address" and the wrong one is what shipped here — which is why the cron-driven learn
// path could not reach a box the daemon-driven draft path was talking to fine.
const SPARK_BASE_URL = env("SPARK_BASE_URL", "http://10.88.88.1:18080/v1");
const SPARK_API_KEY  = readSecret(path.join(HOME, ".openclaw", ".spark-key")) ||
                       env("SPARK_API_KEY");
// This deployment serves exactly ONE chat model (`GET /v1/models`:
// nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4, aliased `nemotron-trtllm`,
// `nemotron-super-trtllm`, `any`) plus the 1B embed/rerank/TTS/STT models — so the
// fast/strong split is nominal today and both resolve to the same weights.
// The previous defaults, openai/gpt-oss-20b and -120b, are NOT downloaded on that server
// and answer `code: model_loading`. `any` is the router's own alias for "the chat model
// this deployment serves": pinning a concrete id is exactly how the learn path died (the
// id went stale and nothing noticed), so the id is resolved at call time and logged from
// the response instead of being frozen here.
const SPARK_MODEL_FAST   = env("SPARK_MODEL_FAST", "any");
const SPARK_MODEL_STRONG = env("SPARK_MODEL_STRONG", "any");

// ── Phase 4: OpenClaw Ghost Agent  (uses full model chain + workspace context)

// ── `ghost learn` analysis model (contact summaries + voice profile)
// Was `google/gemma-3-27b-it:free` on OpenRouter until 2026-08-06, when OR retired the
// `:free` variant and began answering the slug with a permanent 404. Learn now runs on
// the local Spark box instead: free, on Klein's own hardware, and not one provider
// pricing decision away from dying again. Override with $GHOST_LEARN_MODEL.
const LEARN_MODEL = env("GHOST_LEARN_MODEL", "any");

// The draft path's 200-token budget is right for a two-line text reply and wrong for
// learn: the voice-profile prompt asks for seven `##` sections and the contact prompt for
// six. A profile generated under a 200-token cap comes back cut off mid-sentence — and a
// truncated document still reads as a real one, so the emptiness guard would pass it and
// Ghost would speak as Klein from a fragment. Hence a per-call budget rather than a
// global bump, which would have made every draft six times more expensive.
//
// 3000, not the 1200 first estimated: a live run on 2026-08-13 hit finish_reason=length
// at 1200 with the truncation guard catching it. Measured on that box, a contact summary
// (6 sections) costs ~500 tokens / 25 s and generation runs ~20 tok/s, so the 7-section
// profile needs roughly double the first estimate. This is a ceiling, not a target —
// unused headroom costs nothing, and the model is local and free.
const LEARN_MAX_TOKENS = 3000;

// At ~20 tok/s a full-budget generation takes ~150 s, so the 30 s budget that suited a
// small hosted model would abort a healthy run partway through.
const LEARN_TIMEOUT_MS = 300000;

// How many `##` sections each learn prompt asks the model to produce. Used as a
// completeness oracle that does not depend on the provider setting `finish_reason`.
const VOICE_PROFILE_SECTIONS   = 7;
const CONTACT_SUMMARY_SECTIONS = 6;

// ═══════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function readSecret(filePath) {
  try { return fs.readFileSync(filePath, "utf8").trim(); } catch { return ""; }
}

function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
}

function writeFileSafe(filePath, content) {
  const tmp = filePath + ".tmp";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

function loadJson(filePath, def = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return def; }
}

function saveJson(filePath, data) {
  writeFileSafe(filePath, JSON.stringify(data, null, 2));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] [ghost] ${msg}`);
}

function hasInternalDriftMarkers(text) {
  if (!text) return false;
  const norm = String(text).normalize("NFKC");
  const checks = [
    /\[\s*kleinclaw\s*[-_ ]\s*ghost\s*\]/i,
    /\bkleinclaw\s*[-_ ]\s*ghost\b/i,
    /\bexec\s*:/i,
    /\bread\s*:/i,
    /\bmodel\s+fallback\b/i,
    /\bopenclaw\/(workspace|governance)\b/i,
    /\bworkspace-ghost\b/i,
    /\bmcporter\b/i,
    /\bsystemctl\s+--user\b/i,
    /\.openclaw\//i,
  ];
  return checks.some(re => re.test(norm));
}

function eventDedupKey(eventType, eventData) {
  const guid = (eventData?.guid || "").toString().trim();
  if (guid) return `${eventType}:guid:${guid}`;

  const rowId = eventData?.originalROWID;
  if (rowId !== undefined && rowId !== null && `${rowId}`.trim() !== "") {
    return `${eventType}:row:${rowId}`;
  }

  const chatGuid = (eventData?.chatGuid || "").toString().trim();
  const text = (extractMessageText(eventData) || "").slice(0, 120);
  const from = eventData?.isFromMe === true ? "me" : "them";
  const hash = crypto.createHash("sha1").update(`${chatGuid}|${from}|${text}`).digest("hex").slice(0, 16);
  return `${eventType}:fallback:${hash}`;
}

function isDuplicateInboundEvent(eventType, eventData) {
  try {
    const key = eventDedupKey(eventType, eventData);
    const now = Date.now();
    const TTL_MS = 12 * 60 * 60 * 1000;

    const data = loadJson(EVENT_DEDUP_FILE, {});
    const seenAt = Number(data[key] || 0);
    if (seenAt && (now - seenAt) < TTL_MS) return true;

    data[key] = now;

    // prune old keys + cap file size
    const entries = Object.entries(data)
      .filter(([, ts]) => Number.isFinite(Number(ts)) && (now - Number(ts)) < TTL_MS)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 4000);

    saveJson(EVENT_DEDUP_FILE, Object.fromEntries(entries));
    return false;
  } catch {
    return false;
  }
}

// ── Adaptive backoff helpers ─────────────────────────────────────────────────
// Level 0 = 5 min, 1 = 10 min, 2 = 20 min, 3 = 40 min, 4+ = pause Ghost.
const BACKOFF_BASE_MS          = 5 * 60 * 1000;
const BACKOFF_MAX_LEVEL        = 4;
const BACKOFF_ESCALATE_WINDOW  = 2.5; // escalate if hit again within 2.5× current window

function getRateBackoff(key) {
  try {
    const data = loadJson(OUTBOUND_BACKOFF_FILE, {});
    return data[key] || { level: 0, lastHitAt: 0 };
  } catch { return { level: 0, lastHitAt: 0 }; }
}

function recordRateLimitHit(key) {
  try {
    const now   = Date.now();
    const data  = loadJson(OUTBOUND_BACKOFF_FILE, {});
    const state = data[key] || { level: 0, lastHitAt: 0 };
    const windowMs = BACKOFF_BASE_MS * Math.pow(2, state.level);
    if (state.lastHitAt && (now - state.lastHitAt) < windowMs * BACKOFF_ESCALATE_WINDOW) {
      state.level = Math.min(state.level + 1, BACKOFF_MAX_LEVEL);
    }
    state.lastHitAt = now;
    data[key] = state;
    saveJson(OUTBOUND_BACKOFF_FILE, data);
    return state.level;
  } catch { return 0; }
}

function clearRateBackoff(key) {
  try {
    const data = loadJson(OUTBOUND_BACKOFF_FILE, {});
    delete data[key];
    saveJson(OUTBOUND_BACKOFF_FILE, data);
  } catch {}
}

// ── Per-contact send lock ────────────────────────────────────────────────────
async function withContactSendLock(contact, fn) {
  const key = normalizePhone(contact) || contact;
  while (sendLocks.has(key)) {
    await sendLocks.get(key).catch(() => {});
  }
  let resolve;
  const lock = new Promise(r => { resolve = r; });
  sendLocks.set(key, lock);
  try {
    return await fn();
  } finally {
    sendLocks.delete(key);
    resolve();
  }
}

function outboundRateGate(contact, chatGuid) {
  try {
    const now = Date.now();
    const key = normalizePhone(contact) || (chatGuid || "");
    if (!key) return { ok: true };

    const FIVE_MIN    = 5 * 60 * 1000;
    const HOUR        = 60 * 60 * 1000;
    const MAX_PER_5   = 1;  // hard limit: one message per 5-min window per contact
    const MAX_PER_HR  = 4;

    // Apply adaptive backoff: add extra effective window at higher levels
    const backoff    = getRateBackoff(key);
    const backoffMs  = backoff.level > 0 ? BACKOFF_BASE_MS * Math.pow(2, backoff.level) : 0;
    const effectiveWindow = FIVE_MIN + backoffMs;

    const data   = loadJson(OUTBOUND_RATE_FILE, {});
    const all    = Array.isArray(data[key]) ? data[key].map(Number).filter(Number.isFinite) : [];
    const inHour = all.filter(ts => (now - ts) < HOUR);
    const inWin  = inHour.filter(ts => (now - ts) < effectiveWindow);

    if (inWin.length >= MAX_PER_5) {
      const level = recordRateLimitHit(key);
      return { ok: false, reason: `rate-limit: ${inWin.length}/${MAX_PER_5} in ${Math.round(effectiveWindow / 60000)}min`, backoffLevel: level, shouldPause: level >= BACKOFF_MAX_LEVEL };
    }
    if (inHour.length >= MAX_PER_HR) {
      const level = recordRateLimitHit(key);
      return { ok: false, reason: `rate-limit: ${inHour.length}/${MAX_PER_HR} in 60min`, backoffLevel: level, shouldPause: level >= BACKOFF_MAX_LEVEL };
    }

    // Successful gate pass — clear any accumulated backoff
    if (backoff.level > 0) clearRateBackoff(key);

    inHour.push(now);
    data[key] = inHour;
    const cleaned = {};
    for (const [k, arr] of Object.entries(data)) {
      const kept = (Array.isArray(arr) ? arr : []).map(Number).filter(ts => Number.isFinite(ts) && (now - ts) < HOUR);
      if (kept.length) cleaned[k] = kept;
    }
    saveJson(OUTBOUND_RATE_FILE, Object.fromEntries(Object.entries(cleaned).sort((a, b) => Math.max(...b[1]) - Math.max(...a[1])).slice(0, 2000)));

    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/**
 * Normalize a BB timestamp to milliseconds.
 * BB direct HTTP timestamps are often in seconds (10-digit); MCP timestamps are in ms (13-digit).
 * BUG-2: comparisons against Date.now() were silently failing for second-based timestamps.
 */
function normalizeTs(ts) {
  if (!ts) return 0;
  return ts > 9_999_999_999 ? ts : ts * 1000;
}

// Button registry helpers

function normalizePhone(input) {
  if (!input) return "";
  const str   = typeof input === "string" ? input : String(input);
  const match = str.match(/\+?[0-9][0-9()\-\s]{6,}[0-9]/g);
  let digits  = (match ? match[0] : str).replace(/[^0-9]/g, "");
  if (digits.length === 10) digits = `1${digits}`;
  return digits;
}

function extractContactPhone(eventData) {
  if (!eventData || typeof eventData !== "object") return "";

  // handle can be a string OR an object like { address: "+1...", originalROWID: N }
  const resolveHandle = (h) => {
    if (!h) return "";
    if (typeof h === "string") return h;
    if (typeof h === "object") return h.address || h.handle || h.id || "";
    return "";
  };

  const candidates = [
    resolveHandle(eventData.handle),
    eventData.address,
    // chatGuid is like "iMessage;-;+12223334444" — extract the last segment
    typeof eventData.chatGuid === "string"
      ? eventData.chatGuid.split(";").pop()
      : null,
    eventData.sender,
    eventData.from,
  ];

  for (const c of candidates) {
    const n = normalizePhone(c);
    if (n && n !== OWNER_PHONE_NORMALIZED) return n;
  }

  // Fallback: participants array
  if (Array.isArray(eventData.participants)) {
    for (const p of eventData.participants) {
      const n = normalizePhone(resolveHandle(p));
      if (n && n !== OWNER_PHONE_NORMALIZED) return n;
    }
  }
  return "";
}

function extractMessageText(eventData) {
  if (!eventData || typeof eventData !== "object") return "";
  for (const key of ["text", "body", "message", "content", "messageText"]) {
    if (eventData[key] && typeof eventData[key] === "string" && eventData[key].trim())
      return eventData[key].trim();
  }
  return "";
}

/**
 * Sanitize a message before sending to the model:
 *   - Strips URLs (links should never reach the model — ghost can't act on them)
 *   - Strips attachment/media markers
 *   - Strips iMessage file names (IMG_1234.jpg, etc.)
 *   - Redacts obvious secret patterns (API keys, bearer tokens)
 * Returns null if nothing substantive remains (media-only message).
 */
function sanitizeMessageText(text) {
  if (!text) return null;
  let t = text.trim();
  // Strip URLs — must come first (may be the entire message)
  t = t.replace(/https?:\/\/\S+/gi, "").trim();
  // Strip [attachment: …] and <attachment> style markers
  t = t.replace(/\[attachment:[^\]]*\]/gi, "").trim();
  t = t.replace(/<attachment[^>]*>/gi, "").trim();
  // Strip bare media filenames (common in iMessage)
  t = t.replace(/\b[\w-]+\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov|pdf|zip|aac|mp3|m4a)\b/gi, "").trim();
  // Redact long base64/hex API key-like strings (>40 alphanum chars in a token)
  t = t.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
  t = t.replace(/\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi, "Bearer [REDACTED]");
  // Clean up multiple spaces/newlines left by stripping
  t = t.replace(/\s+/g, " ").trim();
  return t || null;
}

/**
 * Lightweight sanitize for model prompts — replaces links/media with placeholders
 * instead of removing them, so the model understands what was there.
 */
function sanitizeForModel(text) {
  if (!text) return text;
  let t = text.trim();
  t = t.replace(/https?:\/\/\S+/gi, "[link]");
  t = t.replace(/\[attachment:[^\]]*\]/gi, "[attachment]");
  t = t.replace(/\b[\w-]+\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov|pdf)\b/gi, "[media]");
  t = t.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
  return t.replace(/\s+/g, " ").trim();
}

function tryParseJson(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}


// ═══════════════════════════════════════════════════════════════════════════
//  EMBEDDINGS + MEMORY DB  (sqlite-vec + Google text-embedding-004)
// ═══════════════════════════════════════════════════════════════════════════

function getMemoriesDb() {
  if (_memoriesDb) return _memoriesDb;
  try {
    const Database  = require("better-sqlite3");
    const sqliteVec = require("sqlite-vec");
    const db = new Database(GHOST_MEMORIES_DB);
    sqliteVec.load(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS contact_memories (
        id        INTEGER PRIMARY KEY,
        phone     TEXT    NOT NULL,
        ts        INTEGER NOT NULL,
        role      TEXT    NOT NULL,
        text      TEXT    NOT NULL,
        embedding BLOB
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_memories_unique
        ON contact_memories(phone, ts, role);
      CREATE INDEX IF NOT EXISTS idx_contact_memories_phone
        ON contact_memories(phone);
    `);
    _memoriesDb = db;
    return db;
  } catch (err) {
    log(`getMemoriesDb: failed to open — ${err.message.slice(0, 80)}`);
    return null;
  }
}

/**
 * Call Google text-embedding-004 to get a 768-dim Float32Array.
 * Returns null on failure (graceful degradation).
 */
async function embedText(text) {
  if (!GEMINI_API_KEY) return null;
  try {
    const body = JSON.stringify({
      model:   "models/gemini-embedding-001",
      content: { parts: [{ text }] },
    });
    const result = await new Promise((resolve, reject) => {
      const url  = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`;
      const opts = {
        hostname: "generativelanguage.googleapis.com",
        path:     `/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
        method:   "POST",
        headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      };
      const req = https.request(opts, (res) => {
        let data = "";
        res.on("data", c => { data += c; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            const values = parsed?.embedding?.values;
            if (Array.isArray(values) && values.length === EMBED_DIMS) {
              resolve(new Float32Array(values));
            } else {
              reject(new Error(`unexpected embed response: ${JSON.stringify(parsed).slice(0, 100)}`));
            }
          } catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error("embed timeout")); });
      req.write(body);
      req.end();
    });
    return result;
  } catch (err) {
    log(`embedText error: ${err.message.slice(0, 80)}`);
    return null;
  }
}

/**
 * Insert a message row and asynchronously attach an embedding.
 * Non-blocking — caller does NOT await.
 */
function indexMessage(phone, ts, role, text) {
  if (!text || text.trim().length < 3) return;
  const n = normalizePhone(phone);
  const db = getMemoriesDb();
  if (!db) return;
  try {
    // Insert without embedding first (fast path)
    db.prepare(`
      INSERT OR IGNORE INTO contact_memories (phone, ts, role, text, embedding)
      VALUES (?, ?, ?, ?, NULL)
    `).run(n, ts, role, text.trim());

    // Asynchronously embed and update
    embedText(text.trim()).then(vec => {
      if (!vec) return;
      try {
        const blob = Buffer.from(vec.buffer);
        db.prepare(`UPDATE contact_memories SET embedding = ? WHERE phone = ? AND ts = ? AND role = ?`)
          .run(blob, n, ts, role);
      } catch {}
    }).catch(() => {});
  } catch (err) {
    // unique constraint violation = duplicate, that's ok
    if (!err.message.includes("UNIQUE")) log(`indexMessage error: ${err.message.slice(0,60)}`);
  }
}

/**
 * Find the top-K most relevant messages for a given phone using cosine similarity.
 * Gracefully returns [] if embeddings are unavailable.
 */
async function queryRelevantMemory(incomingText, phone, topK = 5) {
  const db = getMemoriesDb();
  if (!db) return [];
  const queryVec = await embedText(incomingText);
  if (!queryVec) return [];
  const n = normalizePhone(phone);
  try {
    const rows = db.prepare(`
      SELECT text, role, ts, vec_distance_cosine(embedding, ?) AS distance
      FROM contact_memories
      WHERE phone = ? AND embedding IS NOT NULL
      ORDER BY distance ASC
      LIMIT ?
    `).all(Buffer.from(queryVec.buffer), n, topK);
    return rows.map(r => ({ text: r.text, role: r.role, ts: r.ts }));
  } catch (err) {
    log(`queryRelevantMemory error: ${err.message.slice(0,80)}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CONVERSATION STATE MACHINE  (variable cooldown: stranger vs. active)
// ═══════════════════════════════════════════════════════════════════════════

function loadConvState() {
  return loadJson(GHOST_CONV_STATE_FILE, {});
}

function saveConvState(state) {
  saveJson(GHOST_CONV_STATE_FILE, state);
}

function randomCooldown(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs) + minMs);
}

/**
 * Returns the cooldown in ms before auto-sending to this phone.
 * - 'active' mode (≥3 ghost sends): 1.5–3.5 min (random)
 * - relationship tier (known contact, no active state): fixed per category
 * - stranger/unknown: friend-tier fixed value as fallback
 */
function getCooldownMs(phone) {
  const n     = normalizePhone(phone);
  const state = loadConvState();
  const entry = state[n];
  if (entry && entry.mode === "active") {
    // Check if active mode timed out (5min silence since last ghost send)
    const lastSend = entry.lastGhostSendAt ? new Date(entry.lastGhostSendAt).getTime() : 0;
    if (Date.now() - lastSend > ACTIVE_TIMEOUT_MS) {
      // timed out — treat as friend tier (contact's relationship category or friend fallback)
      const { numToCategory } = loadContactsMap();
      const cat = numToCategory[n] || "friend";
      return CATEGORY_AUTO_SEND_MS[cat] ?? CATEGORY_AUTO_SEND_MS.friend;
    }
    return randomCooldown(COOLDOWN_ACTIVE_MIN_MS, COOLDOWN_ACTIVE_MAX_MS);
  }
  // Non-active: use relationship tier (friend fallback for unknown contacts)
  const { numToCategory } = loadContactsMap();
  const cat = numToCategory[n] || "friend";
  return CATEGORY_AUTO_SEND_MS[cat] ?? CATEGORY_AUTO_SEND_MS.friend;
}

/** Called when ghost successfully sends to a contact. */
function onGhostSend(phone) {
  const n     = normalizePhone(phone);
  const state = loadConvState();
  const entry = state[n] || { exchangeCount: 0 };
  entry.exchangeCount   = (entry.exchangeCount || 0) + 1;
  entry.lastGhostSendAt = new Date().toISOString();
  entry.lastMode        = "ghost_sent";
  if (entry.exchangeCount >= ACTIVE_EXCHANGE_THRESHOLD) entry.mode = "active";
  state[n] = entry;
  saveConvState(state);
}

/** Called when a contact sends us a message. */
function onContactMessage(phone) {
  const n     = normalizePhone(phone);
  const state = loadConvState();
  const entry = state[n] || { exchangeCount: 0 };
  entry.lastContactMsgAt = new Date().toISOString();
  entry.lastMode         = "contact_sent";
  // If active but ghost has been silent > ACTIVE_TIMEOUT_MS, clear mode (reverts to stranger on next load)
  if (entry.mode === "active") {
    const lastSend = entry.lastGhostSendAt ? new Date(entry.lastGhostSendAt).getTime() : 0;
    if (Date.now() - lastSend > ACTIVE_TIMEOUT_MS) {
      delete entry.mode;
      entry.exchangeCount = 0;
    }
  }
  state[n] = entry;
  saveConvState(state);
}

// ═══════════════════════════════════════════════════════════════════════════
//  PROMPT INJECTION SCANNER
// ═══════════════════════════════════════════════════════════════════════════

const INJECTION_PATTERNS = [
  // ── Classic injection ──────────────────────────────────────────────────
  { re: /ignore\s+(all\s+)?previous\s+instructions/i,                label: "ignore previous instructions" },
  { re: /disregard\s+(your\s+)?(previous|prior|all)/i,               label: "disregard previous" },
  { re: /new\s+instructions?:/i,                                     label: "new instructions" },
  { re: /\bforget\s+(everything|all\s+(previous|prior|your)\s+\w+|your\s+instructions?)\b/i, label: "forget everything" },

  // ── Identity probing / fishing ─────────────────────────────────────────
  { re: /you\s+are\s+(now\s+)?(an?\s+)?(?:ai|bot|assistant|language model|llm|chatbot|gpt|claude|gemini)/i, label: "you are an AI" },
  { re: /as\s+an?\s+(ai|language model|llm|chatbot|gpt)/i,           label: "as an AI" },
  { re: /your\s+true\s+(identity|purpose|role|nature)/i,             label: "true identity" },
  { re: /\bare\s+you\s+(an?\s+)?(ai|bot|robot|chatbot|language model|artificial|computer|machine|program|automated)/i, label: "identity fishing: are you an AI" },
  { re: /\bare\s+you\s+(a\s+)?real(\s+person)?\b/i,                   label: "identity fishing: are you real" },
  { re: /\bare\s+you\s+human\b/i,                                    label: "identity fishing: are you human" },
  { re: /\bi\s+know\s+you.?re\s+(an?\s+)?(ai|bot|fake|not\s+real)/i, label: "identity fishing: I know you're AI" },
  { re: /\badmit\s+(you.?re|that\s+you)\s+(an?\s+)?(ai|bot|fake|not\s+real|not\s+human|artificial)/i, label: "identity fishing: admit you're AI" },
  { re: /\bwho\s+(made|created|built|programmed|trained)\s+you\b/i,  label: "identity fishing: who made you" },
  { re: /\bwhat\s+(model|version|ai)\s+are\s+you\b/i,               label: "identity fishing: what model are you" },
  { re: /\bpass\s+(the\s+)?turing\s+test\b/i,                        label: "identity fishing: turing test" },

  // ── Prompt/instruction extraction ──────────────────────────────────────
  { re: /reveal\s+(your\s+)?(system\s+)?prompt/i,                    label: "reveal prompt" },
  { re: /repeat\s+(back\s+)?(everything|your instructions|your prompt)/i, label: "repeat instructions" },
  { re: /print\s+(your\s+)?(instructions?|prompt|rules|system\s+message)/i, label: "print instructions" },
  { re: /what\s+(are|were)\s+your\s+(instructions?|rules|guidelines|system\s+prompt)/i, label: "what are your instructions" },
  { re: /\bshow\s+(me\s+)?(your\s+)?(system\s+)?(prompt|instructions|rules)\b/i, label: "show prompt" },
  { re: /\bout(put|print)\s+(your\s+)?(full\s+)?(system|hidden|secret)/i, label: "output system prompt" },

  // ── Role hijacking ────────────────────────────────────────────────────
  { re: /\bact\s+as\b/i,                                             label: "act as" },
  { re: /\bpretend\s+(you\s+are|to\s+be)\b/i,                        label: "pretend you are" },
  { re: /\broleplay\s+as\b/i,                                        label: "roleplay as" },
  { re: /\bsimulate\s+(being|you\s+are)\b/i,                         label: "simulate being" },
  { re: /\byou\s+are\s+now\s+/i,                                     label: "you are now (role switch)" },

  // ── L1B3RT4S / Pliny-style jailbreaks ─────────────────────────────────
  { re: /GODMODE[\s:]*ENABLED/i,                                     label: "L1B3RT4S: GODMODE" },
  { re: /!JAILBREAK/i,                                               label: "L1B3RT4S: !JAILBREAK" },
  { re: /!OPPO\b/i,                                                  label: "L1B3RT4S: !OPPO" },
  { re: /!MODECOLLAPSE/i,                                            label: "L1B3RT4S: !MODECOLLAPSE" },
  { re: /!OMNI\b/i,                                                  label: "L1B3RT4S: !OMNI" },
  { re: /RESET_CORTEX/i,                                             label: "L1B3RT4S: RESET_CORTEX" },
  { re: /!OBFUSCATE/i,                                               label: "L1B3RT4S: !OBFUSCATE" },
  { re: /!PLINYOS/i,                                                 label: "L1B3RT4S: !PLINYOS" },
  { re: /LOVE\s*PLINY/i,                                             label: "L1B3RT4S: LOVE PLINY" },
  { re: /I'?m\s+free!?\s*.*GODMODE/i,                                label: "L1B3RT4S: I'm free GODMODE" },
  { re: /Sure,?\s+here\s+you\s+are\s+my\s+fren/i,                   label: "L1B3RT4S: fren template" },
  { re: /\bvq_1337\b/i,                                              label: "L1B3RT4S: vq_1337" },
  { re: /ResponseFormat:\s*1\.\s*your\s+response/i,                  label: "L1B3RT4S: ResponseFormat template" },
  { re: /START\s*OF\s*OUTPUT|END\s*OF\s*INPUT|START\s*OF\s*INPUT/i,   label: "L1B3RT4S: IO boundary markers" },
  { re: /refusal\s+mechanisms?[\s:]*disabled/i,                       label: "L1B3RT4S: refusal disabled" },
  { re: /semantically\s*\n\s*fully\s*\n\s*godmode/is,                label: "L1B3RT4S: semantic godmode" },

  // ── Model control tokens (jailbreak delimiters) ────────────────────────
  { re: /<\|/,                                                        label: "model control token: <|" },
  { re: /\[INST\]/,                                                   label: "model control token: [INST]" },
  { re: /<<SYS>>/,                                                    label: "model control token: <<SYS>>" },
  { re: /\[SYSTEM\]/i,                                                label: "model control token: [SYSTEM]" },
  { re: /\[\/INST\]/,                                                 label: "model control token: [/INST]" },
  { re: /<\/?s>/,                                                     label: "model control token: <s>" },

  // ── Encoded/obfuscated payloads ────────────────────────────────────────
  { re: /\b(base64|decode|eval|exec)\s*\(/i,                         label: "code execution attempt" },
  { re: /[01]{32,}/,                                                  label: "binary encoded payload" },

  // ── DAN / Do Anything Now variants ─────────────────────────────────────
  { re: /\bDAN\b.*\b(mode|prompt|jailbreak|enabled)/i,               label: "DAN jailbreak" },
  { re: /\bdo\s+anything\s+now\b/i,                                  label: "DAN: do anything now" },
  { re: /\bdeveloper\s+mode\s+(enabled|on|activated)/i,              label: "developer mode" },
];

/**
 * Returns { safe: true } or { safe: false, reason: string }
 */
function scanForInjection(messageText) {
  if (!messageText) return { safe: true };
  for (const { re, label } of INJECTION_PATTERNS) {
    if (re.test(messageText)) {
      return { safe: false, reason: `prompt injection detected: ${label}` };
    }
  }
  return { safe: true };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CONTENT SAFETY FILTER
// ═══════════════════════════════════════════════════════════════════════════

function passesContentSafety(draftText, tier = "unknown") {
  if (!draftText) return true;

  if (hasInternalDriftMarkers(draftText)) {
    log(`[${tier}] Internal pipeline marker detected in draft — rejecting`);
    return false;
  }
  for (const pattern of NEVER_SAY) {
    if (pattern.test(draftText)) {
      if (pattern === CJK_PATTERN) {
        log(`[${tier}] CJK characters detected in draft — rejecting`);
      }
      return false;
    }
  }
  // Hard block: always fire — unambiguous scheduling commitments
  for (const pattern of HARD_COMMITMENT_PATTERNS) {
    if (pattern.test(draftText)) {
      log(`[${tier}] Hard commitment language detected in draft — rejecting: "${draftText.slice(0, 80)}"`);
      return false;
    }
  }
  // Soft block: only fire when the draft also contains scheduling context keywords
  if (SCHEDULING_CONTEXT.test(draftText)) {
    for (const pattern of SOFT_COMMITMENT_PATTERNS) {
      if (pattern.test(draftText)) {
        log(`[${tier}] Soft commitment language in scheduling context — rejecting: "${draftText.slice(0, 80)}"`);
        return false;
      }
    }
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CONTACTS
// ═══════════════════════════════════════════════════════════════════════════

function loadAllowlist() {
  const contacts = [];
  try {
    const raw = readFileSafe(CONTACTS_FILE);
    let inBlock = false;
    for (const line of raw.split("\n")) {
      if (line.includes("CONTACT_ALLOWLIST_START")) { inBlock = true; continue; }
      if (line.includes("CONTACT_ALLOWLIST_END"))   { inBlock = false; continue; }
      if (!inBlock) continue;
      const m = line.match(/^-\s+(.+?)\s*\|\s*(\+[\d]+)\s*\|\s*(\w+)\s*(?:\|\s*(.*))?$/);
      if (m) {
        // Supports two formats:
        //   4-field (legacy): - Name | +phone | policy | Label
        //   5-field (current): - Name | +phone | policy | category | Label | notes...
        const KNOWN_CATEGORIES = new Set(["family_close","close_friend","friend","acquaintance"]);
        const GENERIC_LABELS   = new Set(["friend","acquaintance","contact","colleague","coworker","classmate","mom","dad",""]);

        const rest    = (m[4] || "").split("|").map(s => s.trim());
        let category  = null;
        let labelField = "";

        if (rest.length >= 2 && KNOWN_CATEGORIES.has(rest[0].toLowerCase())) {
          // 5-field format: rest[0]=category, rest[1]=description (not an alias)
          // The 5th field is a human note/description — NOT used as display name.
          // Always use the name field (m[1]) for 5-field entries.
          category   = rest[0].toLowerCase();
          labelField = ""; // force alias to fall back to m[1] (the actual name)
        } else {
          // Legacy 4-field: rest[0]=label (short alias like "Sam J", "Friend")
          labelField = rest[0] || "";
        }

        // Alias: use label if it's a meaningful name, fall back to full name field.
        // CONTACTS.md uses preferred display names (e.g. "Brenda", "Nick", "Sam J")
        // so we use the full name field rather than truncating to first word.
        const alias = GENERIC_LABELS.has(labelField.toLowerCase())
          ? m[1].trim()                 // use full display name from CONTACTS.md
          : (labelField || m[1].trim());

        contacts.push({
          name:     m[1].trim(),
          phone:    normalizePhone(m[2]),
          policy:   m[3].trim().toLowerCase(),
          category: category || "friend",
          alias,
        });
      }
    }
  } catch {}
  return contacts;
}

function loadContactsMap() {
  const numToName = {}, numToAlias = {}, numToCategory = {};
  for (const c of loadAllowlist()) {
    numToName[c.phone]     = c.name;
    numToAlias[c.phone]    = c.alias;
    numToCategory[c.phone] = c.category;
  }
  return { numToName, numToAlias, numToCategory };
}

function isAllowed(phone) {
  const n = normalizePhone(phone);
  return loadAllowlist().some(c => c.phone === n && c.policy !== "ignore");
}

function isDenied(phone) {
  const n = normalizePhone(phone);
  const list = loadJson(DENYLIST_FILE, []);
  return Array.isArray(list) && list.includes(n);
}

// Free-text values written into a CONTACTS.md allowlist line. Newlines, "|" and HTML comment
// markers would let a crafted name (from /approve-contact or Apple Contacts) inject extra
// allowlist entries or break the CONTACT_ALLOWLIST block.
function sanitizeContactField(value) {
  let s = String(value ?? "");
  // Repeat until stable: a single pass lets nested input ("CONTACT_ALLOWLIST_CONTACT_ALLOWLIST_ENDEND")
  // reassemble the marker it just removed.
  for (let prev = null; prev !== s; ) {
    prev = s;
    s = s.replace(/<!--|-->|CONTACT_ALLOWLIST_(START|END)/gi, "");
  }
  return s
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function addToAllowlist(phone, name, { source = "manual", emails = [], birthday = null, notes = "" } = {}) {
  const n         = normalizePhone(phone);
  if (!n) throw new Error("invalid phone");
  const displayName = sanitizeContactField(name) || "Unknown";
  notes    = sanitizeContactField(notes);
  birthday = birthday ? sanitizeContactField(birthday) : null;
  const sourceNote = source === "apple_contacts"
    ? `From Apple Contacts ${new Date().toISOString().slice(0, 10)}`
    : source === "discord_approve"
    ? "Approved via Discord"
    : `Added ${new Date().toISOString().slice(0, 10)}`;
  const extraNotes = [notes, birthday ? `birthday ${birthday}` : ""].filter(Boolean).join("; ");
  const line = `- ${displayName} | +${n} | ask | friend | ${sourceNote}${extraNotes ? " | " + extraNotes : ""}\n`;
  const raw    = readFileSafe(CONTACTS_FILE);
  const marker = "<!-- CONTACT_ALLOWLIST_END -->";
  writeFileSafe(CONTACTS_FILE, raw.replace(marker, line + marker));
  // Remove from denylist — last action wins (approve after deny = approved)
  const denyList = loadJson(DENYLIST_FILE, []);
  const filtered = denyList.filter(d => d !== n);
  if (filtered.length !== denyList.length) { saveJson(DENYLIST_FILE, filtered); log(`Removed +${n} from denylist (approve wins)`); }
  log(`Added +${n} to allowlist as "${displayName}" (source: ${source})`);
}

function addToDenylist(phone) {
  const n    = normalizePhone(phone);
  if (!n) throw new Error("invalid phone");
  const list = loadJson(DENYLIST_FILE, []);
  if (!list.includes(n)) { list.push(n); saveJson(DENYLIST_FILE, list); }
  // Remove from allowlist — last action wins (deny after approve = denied).
  // Match the phone field exactly: a substring match on "+<n>" let a short code like
  // 12345 delete every +12345… contact, and an empty number delete every line with a "+".
  const raw     = readFileSafe(CONTACTS_FILE);
  const cleaned = raw.split("\n").filter(l => {
    const m = l.match(/^-\s+.+?\s*\|\s*(\+\d+)\s*\|/);
    return !(m && normalizePhone(m[1]) === n);
  }).join("\n");
  if (cleaned !== raw) { writeFileSafe(CONTACTS_FILE, cleaned); log(`Removed +${n} from allowlist (deny wins)`); }
  log(`Added +${n} to denylist`);
}

/**
 * Returns false for messages that obviously don't need a reply:
 * one-word acks, emoji-only, conversation closers, reactions.
 */
function requiresReply(messageText) {
  if (!messageText || !messageText.trim()) return false;
  const raw = messageText.trim();
  // Normalize curly quotes so tapback regex matching is robust regardless of quote style
  const t   = raw.toLowerCase().replace(/[!?.]+$/, "").trim().replace(/[\u201C\u201D]/g, '"');

  // ── Emoji-only ──────────────────────────────────────────────────────────
  if (/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\s]+$/u.test(raw)) return false;

  // ── iMessage tapback reactions ───────────────────────────────────────────
  // Matches both straight and curly quotes; max 200-char quoted text to be safe
  if (/^(liked|loved|disliked|emphasized|questioned|laughed at) ["\u201C\u201D].{0,200}["\u201D]$/.test(t)) return false;

  // ── Exact ack set (strip trailing punctuation before matching) ───────────
  const noReplyExact = new Set([
    // affirmatives / acks
    "ok","okay","k","kk","kkk","okie","okie dokie",
    "got it","gotcha","gotchu","noted","copy","roger","10-4",
    "yep","yup","yea","yeah","ye","yes","no","nah","nope","nope nope",
    "sure","of course","absolutely","definitely","for sure","fs","ofc",
    "alright","aight","ight","aite","bet","bet bet","say less","say no more",
    "will do","on it","done","handled","taken care of","all good","we good",
    // gratitude
    "thanks","thx","ty","thnx","thank you","thank u","thanks a lot",
    "thanks so much","thank you so much","thanks!","ty!","thx!",
    "much appreciated","appreciate it","appreciate that","appreciate you",
    "no worries","no problem","np","nw","no prob","don't worry about it",
    // conversational closers
    "lol","lmao","lmfao","haha","hahaha","hehe","lmaooo","💀",
    "true","facts","word","fr","ik","i know","same","mood","real","valid",
    "omg","wow","damn","crazy","wild","nice","cool","great","perfect",
    "sounds good","makes sense","that makes sense","fair enough","fair",
    "talk later","ttyl","ttys","talk soon","speak soon","talk later",
    "bye","byee","byeee","later","laters","cya","see ya","see you","see you later",
    "good night","gnight","gn","night","good morning","gm","morning",
    "on my way","omw","be there soon","almost there","5 min","10 min","be right there","brt",
    "brb","back","im back","i'm back",
    // emoji acks
    "👍","👍🏻","👍🏼","👍🏽","👍🏾","👍🏿","👌","👌🏻",
    "✓","✔","✔️","☑️","🫡","🙏","🙏🏻","❤️","♥️","🫶",
    "😂","😭","💀","🤣","😅","🥹","🤙","🤙🏻",
  ]);
  if (noReplyExact.has(t)) return false;

  // ── Short fuzzy acks (≤20 chars after stripping punct) ──────────────────
  if (t.length <= 20) {
    // gratitude + filler combos: "thanks man", "ty bro", "thanks dude", etc.
    if (/^(thanks?|thank you|ty|thx)\b/.test(t)) return false;
    // ok/got it + filler: "ok sounds good", "got it thanks", "ok will do"
    if (/^(ok|okay|k|got it|will do|sounds good)\b/.test(t)) return false;
    // closers with emojis or words: "bye!", "later man", "gn bro"
    if (/^(bye|later|cya|gn|ttyl|see ya|good night|good morning)\b/.test(t)) return false;
    // pure affirmation variations: "yeah for sure", "yep sounds good"
    if (/^(yeah|yep|yup|yea|nah|nope)\b/.test(t)) return false;
  }

  // ── URL-only messages — strip and check if anything meaningful remains ──
  const withoutUrls = raw.replace(/https?:\/\/\S+/gi, "").replace(/\[(?:attachment|image|photo|video|file)[^\]]*\]/gi, "").trim();
  if (!withoutUrls) return false;  // message was only URLs/attachments

  // ── iMessage attachment-only markers (no text to respond to) ────────────
  if (/^\s*(\[?(?:attachment|image|photo|video|file)[^\]]*\]?\s*)+$/i.test(raw)) return false;

  // ── Sensitive content — ghost should stay out of these ─────────────────
  // Klein needs to handle these personally; ghost drafting here would be inappropriate.
  const sensitivePatterns = [
    /\b(died?|death|passed away|passing|funeral|condolen|grief|grieving|mourn)\b/i,
    /\b(cancer|diagnos|terminal|hospice|hospital|surgery|emergency|ambulance|911)\b/i,
    /\b(suicide|self.harm|hurt (my)?self|kill (my)?self|want to die)\b/i,
    /\b(break(ing)? up|broke up|we('re| are) over|it'?s over between)\b/i,
    /\b(cheating|cheated on|affair|infidelity)\b/i,
    /\b(fired|laid off|lost (my )?job)\b/i,
    /\b(arrested|in jail|in prison|bail|lawyer up)\b/i,
    /\b(i love you|love you|i('m| am) in love)\b/i,  // too personal for ghost
    // ── Technical/system access requests — Klein must decide these, not ghost ──
    /\b(ssh|sftp|ftp|scp)\s+(access|into|to|server|key|creds?)/i,
    /\b(send|give|share)\s+.{0,30}\bssh\s+key\b/i,
    /\b(server|machine|box|vps|vm|nas)\s+(access|creds?|password|login)/i,
    /\b(lemme|let me|can i|could i|could i have|can i get)\s+(get|have|use)?\s*(ssh|access|creds?|your login|your password)/i,
    /\bremote\s+(access|into|desktop)\b/i,
    /\bvpn\s+(access|config|credentials?|creds?|setup)\b/i,
    /\b(api.?key|secret.?key|private.?key|passphrase)\b/i,
  ];
  if (sensitivePatterns.some(p => p.test(raw))) return false;

  return true;
}

function logSpam(phone, text, reason) {
  try {
    const log = loadJson(SPAM_LOG_FILE, []);
    log.push({ phone: `+${normalizePhone(phone)}`, text: (text || "").slice(0, 200), reason, ts: new Date().toISOString() });
    // Keep last 500 entries
    if (log.length > 500) log.splice(0, log.length - 500);
    saveJson(SPAM_LOG_FILE, log);
  } catch {}
}

function isRateLimited(phone) {
  // Block if same unknown number sends 3+ messages in 5 minutes
  try {
    const n    = normalizePhone(phone);
    const data = loadJson(SPAM_RATELIMIT_FILE, {});
    const now  = Date.now();
    const WINDOW_MS = 5 * 60 * 1000;
    const recent = (data[n] || []).filter(ts => now - ts < WINDOW_MS);
    recent.push(now);
    data[n] = recent;
    saveJson(SPAM_RATELIMIT_FILE, data);
    return recent.length >= 3;
  } catch { return false; }
}

function isLikelySpam(phone, text) {
  const t  = (text || "").toLowerCase();
  const n  = normalizePhone(phone);
  const raw = text || "";

  // 1. Short-code senders (5-6 digit numbers) — always spam
  if (/^\d{5,6}$/.test(n)) {
    logSpam(phone, text, "short_code");
    return true;
  }

  // 2. Expanded spam keyword list
  const spamWords = [
    // Original keywords
    "free gift", "you've won", "you have won", "claim your prize", "click here",
    "limited time offer", "act now", "car warranty", "extended warranty",
    "bitcoin investment", "crypto opportunity", "double your money",
    "guaranteed return", "make money fast", "earn $", "work from home",
    "verify your account", "account suspended", "unusual activity",
    "social security", "irs notice", "tax refund", "package waiting",
    "delivery attempt failed", "reply stop", "text stop to opt out",
    // New additions
    "promo code", "coupon", "cash prize", "you are selected", "you've been selected",
    "final notice", "legal action", "arrest warrant", "your loan", "payday loan",
    "pre-approved", "no credit check", "refinance", "dmv notice",
    "usps delivery", "fedex delivery", "ups notification", "package held",
    "your apple id", "your google account", "bank account", "unauthorized transaction",
    "suspicious login", "verify your identity", "confirm your information",
    "congratulations you", "you have been chosen", "winner selected",
    "discounted rate", "special offer expires", "call immediately",
    // Discount/promo spam
    "% off", "percent off", "promo code", "discount code", "coupon code",
    "found a code", "checkout code", "use code", "save now", "deal expires",
    "flash sale", "limited offer", "while supplies last", "exclusive deal",
    "shop now", "order now", "buy now", "get yours", "claim now",
    "reward points", "loyalty points", "gift card", "store credit",
    "free shipping", "no fees", "no interest", "apply now", "sign up now",
  ];
  const matchedKw = spamWords.find(kw => t.includes(kw));
  if (matchedKw) {
    logSpam(phone, text, `keyword:${matchedKw}`);
    return true;
  }

  // 3. URL in message from unknown sender
  if (/https?:\/\/\S+/i.test(raw) && !isAllowed(phone)) {
    logSpam(phone, text, "url_from_unknown");
    return true;
  }

  // 4. Purely numeric message body (OTP-spam, fake verification codes)
  if (/^\d{4,8}$/.test(raw.trim())) {
    logSpam(phone, text, "numeric_only_message");
    return true;
  }

  // 5. ALL CAPS blast (marketing blasts — long messages in all caps)
  if (raw.length > 30 && raw === raw.toUpperCase() && /[A-Z]{5,}/.test(raw)) {
    logSpam(phone, text, "all_caps_blast");
    return true;
  }

  // 6. Rapid-fire rate limiting: same unknown number sending 3+ messages within 5 min
  if (isRateLimited(phone)) {
    logSpam(phone, text, "rate_limited");
    return true;
  }

  // 7. OTP/2FA/verification code patterns — never reply to auth codes from any sender
  const otpPatterns = [
    /\bverification code\b/i,
    /\bauth(?:entication)? code\b/i,
    /\bone.?time (?:password|passcode|code|pin)\b/i,
    /\b(?:is your|as your) (?:verification|auth|sign.?in|security) code\b/i,
    /\bvalid for \d+ minutes?\b/i,
    /\bnever (?:share|forward) (?:this|your) (?:code|otp|pin)\b/i,
    /\bdo not (?:share|forward) (?:this|your) (?:code|otp|pin)\b/i,
    /\byour code is[:\s]+\d{4,8}\b/i,
    /\bcode[:\s]+\d{4,8}\b.{0,30}\bdo not\b/i,
    /\bsecurity code\b.{0,60}\d{4,8}/i,
    /\benter (?:this|the|your) code\b/i,
    /\bconfirmation code\b/i,
    /\bsign.?in code\b/i,
    /\b(?:tiktok|snapchat|instagram|facebook|google|apple|microsoft|twitter|x\.com|venmo|cashapp|paypal|uber|lyft|doordash|coinbase)\b.{0,100}\d{4,8}/i,
    /\b\d{4,8}\b.{0,60}\b(?:verification|auth|otp|code|expires?|valid)\b/i,
  ];
  if (otpPatterns.some(p => p.test(t))) {
    logSpam(phone, text, "otp_code");
    return true;
  }

  return false;
}

/**
 * Strip URLs and attachment markers from a message before sending to the model.
 * Prevents links from polluting the draft prompt; ghost should only respond to text.
 */
function sanitizeMessageForModel(text) {
  if (!text) return "";
  return text
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/\[(?:attachment|image|photo|video|file)[^\]]*\]/gi, "[attachment]")
    .replace(/(\[link\]\s*)+/g, "[link] ")
    .replace(/(\[attachment\]\s*)+/g, "[attachment] ")
    .trim();
}

// ═══════════════════════════════════════════════════════════════════════════
//  PAUSE / STATE
// ═══════════════════════════════════════════════════════════════════════════

function isPaused() {
  try {
    const d = loadJson(PAUSE_FILE, {});
    if (!d || !d.paused) return false;
    if (d.pauseUntil && new Date(d.pauseUntil) <= new Date()) {
      fs.unlinkSync(PAUSE_FILE);
      log("Pause expired — auto-resuming.");
      return false;
    }
    return true;
  } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  90-03 SEND-GATE LAYERS — fail-closed toggle + positive style allowlist
//  (additive checks consumed at the top of the sendIMessage chokepoint)
// ═══════════════════════════════════════════════════════════════════════════

// Master send switch (GHOST-TOGGLE, 70-research addendum 2026-07-30).
// Fail-closed: cold start / missing file / unparseable or non-boolean state
// ⇒ sending DISABLED. Only an explicit affirmative state enables the wire.
// Enable paths (owner-only surfaces):
//   env  GHOST_SEND_ENABLED=1|true              (test harnesses, dev shells)
//   file SEND_TOGGLE_FILE = {"enabled": true}   (operator; re-read every send,
//                                                runtime-toggleable, no restart)
let _lastToggleEnabled = null;
function ghostSendToggleState() {
  let state;
  const env = process.env.GHOST_SEND_ENABLED;
  if (env === "1" || env === "true") {
    state = { enabled: true, source: "env" };
  } else {
    try {
      const d = JSON.parse(fs.readFileSync(SEND_TOGGLE_FILE, "utf8"));
      state = (d && d.enabled === true)
        ? { enabled: true, source: "file" }
        : { enabled: false, reason: "disabled-by-file" };
    } catch {
      state = { enabled: false, reason: "absent" };
    }
  }
  if (_lastToggleEnabled !== state.enabled) {
    log(`Send toggle state: ${state.enabled ? "ENABLED" : "DISABLED"} (${state.source || state.reason})`);
    _lastToggleEnabled = state.enabled;
  }
  return state;
}

// Positive style allowlist (70-research §5b): an outbound must LOOK like a
// casual human text. Structural rejection of assistant/markdown/essay shapes —
// the fail-closed complement to the drift-marker denylist, which can only
// enumerate known-bad strings. Returns null when allowed, else a reason string.
const STYLE_MAX_CHARS    = 640; // a few SMS segments; ghost drafts are casual replies
const STYLE_MAX_NEWLINES = 3;
const STYLE_ALLOWED_EXTRA = "‘’“”–—…"; // ’ ‘ “ ” – — …
// Small explicit emoji allowance — casual-register emoji only, everything else rejected
const STYLE_EMOJI_ALLOW = ["😂","❤️","👍","😊","😅","🙏","😭","💀","🔥","🤣","😉","🙌","😎"];
const STYLE_ASSISTANT_TELLS = [
  /\bas an ai\b/i,
  /\blanguage model\b/i,
  /\bi('m| am) an? (ai|assistant|bot)\b/i,
  /\bhow (can|may) i (help|assist)\b/i,
  /\bi('d| would) be happy to (help|assist)\b/i,
];
function styleAllowlistViolation(text) {
  const t = (text || "").toString();
  if (t.length > STYLE_MAX_CHARS) return "too-long";
  if ((t.match(/\n/g) || []).length > STYLE_MAX_NEWLINES) return "too-many-lines";
  if (/\n\s*\n/.test(t)) return "essay-shape";           // blank-line paragraph breaks
  if (/`/.test(t)) return "backtick";                    // fences AND inline code
  if (/\*\*|__|~~/.test(t)) return "markdown-emphasis";
  if (/^\s*(?:[#>]|[-*]\s|\d+\.\s)/m.test(t)) return "markdown-structure"; // headings/quotes/bullets/lists
  if (/\[[^\]]*\]\([^)]*\)/.test(t)) return "markdown-link";
  if (/^\s*\[[^\]]+\]/.test(t)) return "tag-prefix";     // "[Tag] ..." wrapper shapes
  for (const p of STYLE_ASSISTANT_TELLS) { if (p.test(t)) return "assistant-register"; }
  // Character allowlist: ASCII printable + newline/tab + typographic punctuation
  // + the small emoji allowance. Anything else (CJK, control chars, arbitrary
  // symbols/emoji) is not representable in a casual owner-voice text.
  let rest = t;
  for (const e of STYLE_EMOJI_ALLOW) rest = rest.split(e).join("");
  for (const ch of rest) {
    const cp = ch.codePointAt(0);
    const ascii = cp === 0x0a || cp === 0x09 || (cp >= 0x20 && cp <= 0x7e);
    if (!ascii && !STYLE_ALLOWED_EXTRA.includes(ch)) return "disallowed-characters";
  }
  return null;
}

function isQuietHours(phone) {
  const h    = new Date().getHours();
  const norm = normalizePhone(phone || "");
  const { numToCategory } = loadContactsMap();
  const category = numToCategory[norm] || "friend";
  // family_close + acquaintance: 10pm quiet start; others: 11pm
  const quietStart = (category === "family_close" || category === "acquaintance")
    ? FAMILY_QUIET_HOUR_START
    : QUIET_HOUR_START;
  return h >= quietStart || h < QUIET_HOUR_END;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ASYNC SPAWN HELPER
// ═══════════════════════════════════════════════════════════════════════════

function spawnAsync(cmd, args, { timeout = 30000, input } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "", timer = null;
    const proc = spawn(cmd, args, { env: { ...process.env, HOME } });
    proc.stdout?.on("data", d => { stdout += d.toString(); });
    proc.stderr?.on("data", d => { stderr += d.toString(); });
    proc.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(0, 200)}`));
    });
    proc.on("error", err => { clearTimeout(timer); reject(err); });
    if (timeout) {
      timer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error(`${cmd} timed out`)); }, timeout);
    }
    if (input != null) { proc.stdin?.write(input); proc.stdin?.end(); }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  BLUEBUBBLES API (direct HTTP — fast path for server)
// ═══════════════════════════════════════════════════════════════════════════



/** Newest-first context for one chat (imsg chat_id). [] on any read failure. */
async function fetchRecentMessages(chatId, limit = 20) {
  if (!Number.isInteger(chatId)) return [];
  try {
    return await imsgHistory(chatId, limit);
  } catch (err) {
    log(`fetchRecentMessages(chat ${chatId}) failed: ${(err.message || "").slice(0, 120)}`);
    return [];
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  NATIVE iMESSAGE TRANSPORT  (src/imsg.js — OpenClaw bundled imessage channel)
// ═══════════════════════════════════════════════════════════════════════════

// The three wires to the outside. Production uses src/imsg.js; tests replace them with
// setTransport(). imsgRequest null = use the serve-mode watch session, else a one-shot one.
const transport = {
  imsgRequest:     null,
  sendIMessage:    (target, text) => imsg.sendIMessageNative(target, text),
  requestApproval: (opts) => imsg.requestOwnerApproval(opts),
};
function setTransport(overrides) { Object.assign(transport, overrides); }

// Supervised watch.subscribe session while serving; null for CLI commands.
let imsgWatch = null;

async function imsgRequest(method, params, timeoutMs = 20000) {
  if (transport.imsgRequest) return transport.imsgRequest(method, params, timeoutMs);
  const live = imsgWatch && imsgWatch.getClient();
  if (live) return live.request(method, params, timeoutMs);
  return imsg.withImsgSession(c => c.request(method, params, timeoutMs));
}

/** imsg messages.history → normalized messages, newest first. */
async function imsgHistory(chatId, limit, timeoutMs = 20000) {
  const r = await imsgRequest("messages.history", { chat_id: chatId, limit, attachments: false }, timeoutMs);
  return (Array.isArray(r?.messages) ? r.messages : [])
    .map(imsg.normalizeImsgMessage)
    .filter(Boolean)
    .sort((a, b) => b.dateCreated - a.dateCreated);
}

/** imsg chats.list → raw chat rows ({ id, guid, identifier, ... }). */
async function imsgChats(limit = 1000) {
  const r = await imsgRequest("chats.list", { limit }, 60000);
  return Array.isArray(r?.chats) ? r.chats : [];
}

// ═══════════════════════════════════════════════════════════════════════════
//  MODEL GENERATION  (OR claude-haiku → OR gemini-flash → Spark fallback)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Try OpenRouter with a specific model. Resolves { text, usage, finishReason } or null.
 * `maxTokens` defaults to the draft budget; callers producing a document rather than a
 * text reply must raise it explicitly (see LEARN_MAX_TOKENS).
 */
function tryOpenRouter(model, systemPrompt, userContent, timeoutMs = 20000, maxTokens = 200) {
  return new Promise((resolve) => {
    if (!OPENROUTER_API_KEY) { resolve(null); return; }
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent  },
      ],
      max_tokens:  maxTokens,
      temperature: 0.75,
    });
    const options = {
      hostname: "openrouter.ai",
      path:     "/api/v1/chat/completions",
      method:   "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer":  "https://openclaw.ai",
        "X-Title":       "KleinClaw Ghost",
      },
    };
    const req = https.request(options, (res) => {
      const statusCode = res.statusCode;
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text   = (parsed?.choices?.[0]?.message?.content || "").trim();
          if (text) {
            log(`OR [${model.split("/").pop()}] draft ok`);
            const usage = parsed?.usage || null;
            // finish_reason distinguishes "the model was done" from "the model was cut
            // off at max_tokens". Callers writing a document must reject the latter.
            resolve({ text, usage, finishReason: parsed?.choices?.[0]?.finish_reason || null });
          } else {
            // Log actual error if present (e.g. 429 rate limit, provider error)
            const errMsg = parsed?.error?.message || parsed?.error || "empty response";
            const errCode = parsed?.error?.code ? ` (code ${parsed.error.code})` : "";
            log(`OR [${model.split("/").pop()}] failed: ${String(errMsg).slice(0, 120)}${errCode}`);
            // Detect 429 / rate limit → cool down this model in OR_COOLDOWN_MAP
            const isRateLimit = statusCode === 429 ||
              parsed?.error?.code === 429 ||
              /rate.?limit/i.test(String(errMsg));
            if (isRateLimit) markOrModelCooling(model, 60000);
            resolve(null);
          }
        } catch (e) { log(`OR parse error: ${e.message}`); resolve(null); }
      });
    });
    req.on("error", err => { log(`OR error: ${err.message}`); resolve(null); });
    req.setTimeout(timeoutMs, () => { req.destroy(); log(`OR [${model.split("/").pop()}] timeout`); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Phase 2: Spark vllm ─────────────────────────────────────────────────────

/**
 * Try Spark vllm (local DGX). model = SPARK_MODEL_FAST | SPARK_MODEL_STRONG | LEARN_MODEL.
 * Resolves { text, finishReason, model } or null.
 *
 * `maxTokens` defaults to the draft budget. The learn path passes LEARN_MAX_TOKENS —
 * a document needs far more room than a two-line reply, and running a document prompt
 * under the draft budget produces a plausible-looking fragment rather than a failure.
 */
function trySparkVllm(model, systemPrompt, userContent, timeoutMs = 15000, maxTokens = 300) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      // learn passes no system prompt. Sending `content: ""` puts an empty system turn
      // through the chat template, so omit the turn entirely instead.
      messages: [
        ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
        { role: "user", content: userContent },
      ],
      // Nemotron serves in reasoning mode by default and a long SOUL prompt can burn the whole
      // token budget as reasoning_content before any reply text emits (90-02 attempt #5, empty
      // drafts at finish_reason=length). enable_thinking:false turns reasoning off at the chat
      // template (verified live: has_reasoning=false, clean content); the larger cap is belt.
      max_tokens:  maxTokens,
      temperature: 0.72,
      chat_template_kwargs: { enable_thinking: false },
    });
    const url  = new URL(`${SPARK_BASE_URL}/chat/completions`);
    const opts = {
      hostname: url.hostname,
      port:     parseInt(url.port || "80"),
      path:     url.pathname,
      method:   "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${SPARK_API_KEY}`,
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text   = (parsed?.choices?.[0]?.message?.content || "").trim();
          // `any` is an alias, so log what the router actually resolved it to rather
          // than the alias we asked for — otherwise the log cannot tell you which
          // weights produced the artifact.
          const served = parsed?.model || model;
          if (text) {
            log(`Spark [${served.split("/").pop()}] ok`);
            resolve({ text, finishReason: parsed?.choices?.[0]?.finish_reason || null, model: served });
          } else {
            const errMsg = parsed?.error?.message || "empty response";
            const errCode = parsed?.error?.code ? ` (code ${parsed.error.code})` : "";
            log(`Spark [${served.split("/").pop()}] failed: ${String(errMsg).slice(0, 120)}${errCode}`);
            resolve(null);
          }
        } catch (e) { log(`Spark parse error: ${e.message}`); resolve(null); }
      });
    });
    req.on("error", err => { log(`Spark error: ${err.message}`); resolve(null); });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Phase 4: OpenClaw Ghost Agent ────────────────────────────────────────────


// ── Full draft generation chain ──────────────────────────────────────────────

/**
 * Generate a draft reply using the model failover chain.
 *   1. Spark vllm fast    (local DGX, low-latency — skipped when offline)
 *   2. OR claude-haiku-4.5 (fast, reliable, cheap — primary cloud tier)
 *   3. OR gemini-flash     (fast, reliable backup)
 *   4. Spark vllm strong  (local DGX last resort — skipped when offline)
 *
 * Returns { text, model } or null.
 */
// Cache Spark availability for 5 min to avoid retrying a dead node on every draft
let sparkAvailable = null;
let sparkLastCheck = 0;
function invalidateSparkCache() {
  sparkAvailable = false;
  sparkLastCheck = Date.now(); // re-check in 5min, not immediately
}

// ── In-memory OpenRouter cooldown map ─────────────────────────────────────
// Tracks models that returned 429/rate-limit; prevents retrying until cooldown expires
const OR_COOLDOWN_MAP = new Map(); // modelId (full OR path) → cooldownUntilMs

function markOrModelCooling(modelId, ms = 60000) {
  OR_COOLDOWN_MAP.set(modelId, Date.now() + ms);
  log(`OR cooldown: ${modelId.split("/").pop()} cooling for ${ms / 1000}s`);
}

async function checkSparkAvailable() {
  const now = Date.now();
  if (sparkAvailable !== null && now - sparkLastCheck < 5 * 60 * 1000) return sparkAvailable;
  sparkLastCheck = now;
  return new Promise(resolve => {
    const url = new URL(`${SPARK_BASE_URL}/models`);
    const req = http.request({ hostname: url.hostname, port: parseInt(url.port||"80"), path: url.pathname, method: "GET" }, res => {
      sparkAvailable = res.statusCode < 500;
      resolve(sparkAvailable);
      res.resume();
    });
    req.on("error", () => { sparkAvailable = false; resolve(false); });
    req.setTimeout(2000, () => { req.destroy(); sparkAvailable = false; resolve(false); });
    req.end();
  });
}

// Ghost draft model waterfall — edit here to switch primary
// Order matters: first success wins. Prioritize style-following quality over cost.
// gpt-oss-20b/120b (Spark) are fast but small/code-optimized — poor at style mimicry.
// claude-haiku is the sweet spot: fast, cheap, excellent at following SOUL/contact context.
// Ghost draft model waterfall — cheapest first, escalates on failure/rate-limit
const GHOST_DRAFT_MODELS = [
  { id: "openai/gpt-oss-120b:free",              label: "gpt-oss-120b"     },  // primary: cheapest ($0.039/M free tier)
  { id: "google/gemini-3.1-flash-lite-preview",  label: "gemini-flash-lite" }, // $0.25/M
  { id: "google/gemini-3-flash-preview",         label: "gemini-flash"     },  // $0.50/M
  { id: "anthropic/claude-haiku-4.5",            label: "claude-haiku"     },  // last resort: $0.80/M
];

/**
 * Phase 0.5 — Model Preflight
 * Probes which models are usable RIGHT NOW and returns them in priority order:
 *   ghost-agent (if active) → claude-haiku → gemini-flash → gemini-flash-lite → gpt-oss-120b:free
 *
 * Checks:
 * - Spark: liveness via checkSparkAvailable (5-min cache); leads the list when up
 *   (operator ruling 2026-08-10 — supersedes the old style-task exclusion)
 * - OR models: skipped if OR_COOLDOWN_MAP has a future cooldownUntilMs entry
 */
async function probeAvailableModels() {
  const available = [];

  // 2. Spark (DGX over the wg-nvidia path) — operator ruling 2026-08-10 (90-02 option (b)+(d)):
  //    spark IS the draft path — free, local, and the only tier not gated on external credits.
  //    The old "intentionally excluded: style/persona task" exclusion is superseded by that ruling.
  //
  //    This comment used to claim SPARK_MODEL_FAST/STRONG "now point at the served Nemotron
  //    ids via service env". That was false in the durable sense and cost six days: the
  //    corrected values existed only as exported shell vars in the running daemon's process
  //    environment. No ghost systemd unit exists, and the 3am learn cron inherits none of it,
  //    so learn kept using the stale in-code defaults while drafting worked. The values now
  //    live in the constants above and in .env, which both cron and daemon actually read.
  //
  //    NOTE: checkSparkAvailable probes /v1/models, which answers 200 even while the router
  //    refuses generation (observed 2026-08-13: kv_reuse_isolation_unproven 503 on every
  //    chat completion while /v1/models and embeddings stayed green). "Spark serves a model"
  //    and "Spark will generate" are separate questions; this probe only answers the first,
  //    and the draft path falls through to the OR tiers when generation is refused.
  const sparkUp = await checkSparkAvailable();
  if (sparkUp) {
    available.push("spark-fast");
    log("probeAvailableModels: spark alive — spark-fast leads the waterfall");
  } else {
    log("probeAvailableModels: spark unavailable");
  }

  // 3. OR models — haiku first, then fallbacks.
  const now = Date.now();
  for (const entry of GHOST_DRAFT_MODELS) {
    const coolUntil = OR_COOLDOWN_MAP.get(entry.id);
    if (!coolUntil || now > coolUntil) {
      available.push(entry.label);
    } else {
      log(`probeAvailableModels: ${entry.label} cooling (${Math.ceil((coolUntil - now) / 1000)}s remaining)`);
    }
  }

  // 4. spark-strong closes the waterfall — same box, explicit big-model pin.
  if (sparkUp) available.push("spark-strong");

  return available;
}

// ═══════════════════════════════════════════════════════════════════════════
//  FEEDBACK LOOP
// ═══════════════════════════════════════════════════════════════════════════

function logFeedback(draft, decision) {
  try {
    const { draftId, contact, contactName, draftText, draftModel, postedAt } = draft;
    const { numToCategory } = loadContactsMap();
    const phone = normalizePhone(contact || "");
    const contactCategory = numToCategory[phone] || "unknown";

    const arrivedDate = postedAt ? new Date(postedAt) : new Date();
    const entry = {
      draftId,
      contact: phone,
      contactName: contactName || "",
      contactCategory,
      theirMessage: (draft.messageText || "").slice(0, 200),
      draftText: draftText || "",
      draftModel: draftModel || "",
      decision,
      decisionTimestamp: new Date().toISOString(),
      arrivedHour: arrivedDate.getHours(),
      arrivedDayOfWeek: arrivedDate.getDay(),
    };

    const entries = loadJson(FEEDBACK_FILE, []);
    entries.push(entry);
    // Cap at 500 entries
    if (entries.length > 500) entries.splice(0, entries.length - 500);
    saveJson(FEEDBACK_FILE, entries);
  } catch (err) {
    log(`logFeedback error: ${err.message}`);
  }
}

function recentFeedbackSummary(limit = 20) {
  try {
    const entries = loadJson(FEEDBACK_FILE, []);
    if (!entries.length) return "";

    const recent = entries.slice(-limit);

    // Group by contact
    const byContact = {};
    for (const e of recent) {
      if (!e.contactName) continue;
      if (!byContact[e.contactName]) byContact[e.contactName] = { sent: 0, cancelled: 0, category: e.contactCategory };
      if (e.decision === "sent") byContact[e.contactName].sent++;
      else if (e.decision === "cancelled") byContact[e.contactName].cancelled++;
    }

    const notes = [];

    for (const [name, stats] of Object.entries(byContact)) {
      const total = stats.sent + stats.cancelled;
      if (total < 2) continue;
      if (stats.cancelled > stats.sent) {
        notes.push(`- Klein often cancels drafts for ${name} (${stats.category}) — draft more carefully`);
      } else if (total >= 3 && stats.sent / total >= 0.8) {
        notes.push(`- Style is working for ${name}`);
      }
    }

    // Late-hour cancel pattern
    const lateHourCancels = recent.filter(e => e.decision === "cancelled" && (e.arrivedHour >= 22 || e.arrivedHour < 8));
    if (lateHourCancels.length >= 3) {
      notes.push(`- Klein frequently cancels late-night drafts (${lateHourCancels.length} recent) — be more cautious during late hours`);
    }

    if (!notes.length) return "";
    return `\n\n---\n## RECENT DRAFT FEEDBACK PATTERNS\n${notes.join("\n")}`;
  } catch (err) {
    log(`recentFeedbackSummary error: ${err.message}`);
    return "";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  GHOST AGENT IPC QUEUE TIER
// ═══════════════════════════════════════════════════════════════════════════


// Authenticated OC gateway client — all /tools/invoke calls go through here.
// Adds request ID + timestamp headers for auditability; throws on auth failure.



/**
 * Phase 1 — Draft Generation
 * Calls probeAvailableModels() first to get an ordered list of what's usable right now,
 * then iterates through them until one succeeds. First success wins.
 *
 * Log format: 'Draft: probed [ghost-agent, claude-haiku, gemini-flash] — trying ghost-agent...'
 */
async function generateDraft(systemPrompt, userContent, { contactName, contactPhone, messageText, historyLines } = {}) {
  const available = await probeAvailableModels();
  log(`Draft: probed [${available.join(", ")}] — trying ${available[0] || "none"}...`);

  // Per-tier failure reasons, surfaced on the card (F4 — "content safety" used to be blamed
  // for plain availability failures; the operator needs to know WHICH to fix).
  const tierFailures = [];

  // Helper: check content safety then return or log+skip
  const safeReturn = (text, model) => {
    if (!text) { tierFailures.push(`${model}: no output`); return null; }
    const trimmed = text.trim();
    if (!passesContentSafety(trimmed, model)) {
      tierFailures.push(`${model}: content-safety`);
      log(`Draft failed content safety [${model}] — trying next model`);
      return null;
    }
    return { text: trimmed, model };
  };

  for (const modelKey of available) {
    switch (modelKey) {
      case "spark-fast": {
        log(`Draft: Spark ${SPARK_MODEL_FAST}...`);
        const t = (await trySparkVllm(SPARK_MODEL_FAST, systemPrompt, userContent))?.text || null;
        const r = safeReturn(t, "spark-fast");
        if (r) return r;
        if (!t) { log("Draft: Spark fast returned null — invalidating cache"); invalidateSparkCache(); }
        break;
      }
      default: {
        // OR model — look up in GHOST_DRAFT_MODELS by label
        const orEntry = GHOST_DRAFT_MODELS.find(e => e.label === modelKey);
        if (orEntry) {
          log(`Draft: OR ${orEntry.label}...`);
          const orResult = await tryOpenRouter(orEntry.id, systemPrompt, userContent, 25000);
          // tryOpenRouter returns { text, usage } on success, null on failure
          const rawText = orResult?.text ?? (typeof orResult === "string" ? orResult : null);
          const r = safeReturn(rawText, orEntry.label);
          if (r) return { ...r, usage: orResult?.usage || null };
        }
        break;
      }
      case "spark-strong": {
        log(`Draft: Spark ${SPARK_MODEL_STRONG} (last resort)...`);
        const t = (await trySparkVllm(SPARK_MODEL_STRONG, systemPrompt, userContent, 25000))?.text || null;
        const r = safeReturn(t, "spark-strong");
        if (r) return r;
        if (!t) invalidateSparkCache();
        break;
      }
    }
  }

  const anySafety = tierFailures.some(f => f.endsWith("content-safety"));
  log(`Draft: all tiers failed — ${tierFailures.join("; ") || "no tiers available"}`);
  return { text: null, model: anySafety ? "safety-blocked" : "exhausted", failures: tierFailures };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CONTEXT ASSEMBLY  (SOUL + voice profile + contact memory)
// ═══════════════════════════════════════════════════════════════════════════

function loadContactMemory(phone) {
  const n = normalizePhone(phone);
  try {
    for (const f of fs.readdirSync(CONTACTS_MEMORY_DIR)) {
      if (f.includes(n)) return readFileSafe(path.join(CONTACTS_MEMORY_DIR, f)).trim();
    }
  } catch {}
  return "";
}

/**
 * Redact secret-like patterns from context files before injecting into the model prompt.
 * Defense-in-depth: prevents accidental API key / token leakage from workspace files.
 * NOTE: ghost.js never reads .zshenv or arbitrary .env files — only specific known paths.
 */
function sanitizeSecretsFromContext(text) {
  if (!text) return "";
  return text
    // Long hex strings (32+ chars — API keys, tokens)
    .replace(/\b[0-9a-f]{32,}\b/gi, "[REDACTED_HEX]")
    // OpenAI / Anthropic style API keys
    .replace(/\bsk-[A-Za-z0-9\-_]{20,}\b/g, "[REDACTED_KEY]")
    // Bearer tokens in text
    .replace(/\bBearer [A-Za-z0-9\-_=.]+/g, "Bearer [REDACTED]")
    // JWT-like strings (3 base64 segments)
    .replace(/\bey[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\b/g, "[REDACTED_JWT]");
}

async function buildSystemPrompt(contactName, contactPhone, triggerMessage = "") {
  const soul    = sanitizeSecretsFromContext(readFileSafe(SOUL_FILE).trim());
  const voice   = sanitizeSecretsFromContext(readFileSafe(VOICE_PROFILE_FILE).trim());
  const contact = sanitizeSecretsFromContext(loadContactMemory(contactPhone));

  const { numToCategory } = loadContactsMap();
  const category     = numToCategory[normalizePhone(contactPhone)] || "friend";
  const categoryTone = CATEGORY_TONE[category] || CATEGORY_TONE.friend;

  let prompt = soul || "You ARE Klein. Respond as him — casual, brief, lowercase.";

  if (voice) {
    prompt += `\n\n---\n## YOUR LEARNED VOICE PATTERNS\n${voice}`;
  }
  prompt += `\n\n---\n${categoryTone}`;
  if (contact) {
    prompt += `\n\n---\n## ABOUT ${contactName.toUpperCase()}\n${contact}`;
  }

  // Embedding-based relevant memory injection (replaces flat contact memory file)
  if (triggerMessage) {
    const relevant = await queryRelevantMemory(triggerMessage, contactPhone, 5);
    if (relevant.length > 0) {
      prompt += `\n\n---\n## RECENT RELEVANT CONTEXT\n`;
      prompt += relevant.map(m => `  [${m.role}]: ${m.text}`).join("\n");
    }
  }

  prompt += `\n\n---\n## KLEIN'S CONTEXT (use for reference, don't mention directly)
- Lives in Blacksburg, VA. Junior at Virginia Tech (VT), studying CS.
- Knows US politics well. "Orange Dump" / "Orange man" = Trump (family joke). His mom uses these nicknames.
- Family: Mom (Brenda, lives in PA), Dad (Nicholas). Close-knit.
- Friend group: Jai, Will, Sri, Emmet, Sam J, Gibbs, Max K — all college-aged guys.
- Hobbies: coding, hiking, skiing, gaming. Into tech, Linux, self-hosting.
- Current semester: Spring 2026.`;

  prompt += `\n\n---\nDraft a reply to ${contactName} as Klein. Max 1-2 short texts. No emojis unless genuinely funny. No greeting openers. Output ONLY the reply text — nothing else.`;

  prompt += `\n\nAlways respond in American English only. Never use Chinese, Japanese, or Korean characters under any circumstances.`;

  prompt += `\n\nCRITICAL RULES — these are internal pipeline signals, never shown to the recipient:\n1. NEVER commit Klein to any plan, event, meetup, time slot, or activity. If the message is about scheduling, plans, "are you free", "want to hang", "can you make it", or anything that requires knowing his calendar — output EXACTLY on its own line (this is caught internally and never sent): [CANNOT_ANSWER: cannot commit to plans]\n2. NEVER say "sounds good", "I'm in", "count me in", "see you then/there", "works for me", "I'll be there", "that works", or any phrase that agrees to do something — even casually. If you would naturally write any of those, use [CANNOT_ANSWER: cannot commit to plans] instead.\n3. If the message requires specific personal knowledge not visible in context (specific plans, events, facts about Klein's schedule) — output EXACTLY: [CANNOT_ANSWER: brief reason max 12 words]\n\n[CANNOT_ANSWER: ...] is a pipeline abort signal. It is intercepted before sending and the recipient sees nothing.`;

  const feedbackSummary = recentFeedbackSummary();
  if (feedbackSummary) prompt += feedbackSummary;

  return prompt;
}

function buildUserContent(contactName, messageText, recentMessages, triggerArrivedAt = 0) {
  // recentMessages arrives DESC (newest first) from BB.
  // 1. Exclude the trigger message itself and anything after it (dateCreated >= arrivedAt).
  //    This prevents "oh" from appearing twice and avoids post-trigger clutter.
  // 2. Keep only the 8 messages BEFORE the trigger — closest context wins.
  // 3. Reverse to chronological order (oldest → newest) for the model to read naturally.
  const HISTORY_LIMIT = 8;
  const beforeTrigger = recentMessages
    .filter(m => {
      if (!m.text?.trim()) return false;
      // If we have a timestamp, exclude everything at or after the trigger
      // normalizeTs: BB may return seconds (10-digit) or ms (13-digit) — normalize both to ms
      if (triggerArrivedAt && m.dateCreated && normalizeTs(m.dateCreated) >= triggerArrivedAt) return false;
      // Also exclude messages whose text matches the trigger (belt+suspenders)
      if (m.text?.trim() === messageText?.trim()) return false;
      return true;
    })
    .slice(0, HISTORY_LIMIT)   // take 8 most recent pre-trigger messages (still DESC order)
    .reverse();                 // flip to chronological (oldest → newest)

  const history = beforeTrigger
    .map(m => `${(m.isFromMe === true || m.from === "me") ? "Klein" : contactName}: ${m.text.trim().slice(0, 200)}`)
    .join("\n");

  // Sanitize the trigger message before sending to model: strip URLs and attachment markers.
  // Ghost should respond only to the text content, not links or media placeholders.
  const sanitizedMessage = sanitizeMessageForModel(messageText);
  return `Recent conversation (oldest → newest):\n${history || "(no prior messages)"}\n\nLatest message from ${contactName}:\n"${sanitizedMessage}"\n\nReply as Klein:`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  DISCORD
// ═══════════════════════════════════════════════════════════════════════════

async function postCannotAnswerAlert(contactName, messageText, reason) {
  const safeName = contactName.replace(/[*_`]/g, "\\$&");
  const content  = `❓ **Cannot answer** — ${safeName}\n> "${(messageText || "").slice(0, 200)}"\n_Reason: ${reason}_`;
  await discordPost(GHOST_CHANNEL, { content });
}

// curl reads the auth header from a config on stdin so the bot token never appears in argv
// (argv is world-readable via `ps` / /proc/<pid>/cmdline).
function discordAuthCurlConfig() {
  return `header = "Authorization: Bot ${DISCORD_BOT_TOKEN.replace(/["\\\r\n]/g, "")}"\n`;
}

async function discordPost(channelId, payload) {
  try {
    // Message text often quotes inbound iMessages verbatim — never let it ping @everyone/roles/users.
    const body = { allowed_mentions: { parse: [] }, ...payload };
    const stdout = await spawnAsync("curl", [
      "-s", "-X", "POST",
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      "--config", "-",
      "-H", "Content-Type: application/json",
      "-d", JSON.stringify(body),
    ], { timeout: 10000, input: discordAuthCurlConfig() });
    return tryParseJson(stdout);
  } catch (err) {
    log(`Discord post error: ${err.message}`);
    return null;
  }
}

// ── F9 (2026-08-10 audit): severity-colored embeds for the informational,
// button-less notice classes. These ride raw discordPost (curl), which carries
// embeds fine — the OC gateway path (draft cards, unknown-alert buttons) keeps
// its content+components shape and is NOT converted.
const EMBED_COLORS = {
  injection:     0xED4245, // red — security event
  approval:      0xE67E22, // orange — waiting on Klein's decision
  autodeny:      0x95A5A6, // grey — routine deny/transactional outcome
  transactional: 0x95A5A6,
  expiry:        0x95A5A6,
  info:          0x3498DB, // blue
};

// Discord hard limits: title 256, description 4096, field value 1024,
// field name 256, ≤25 fields, 6000 chars total across the embed.
function buildNoticeEmbed({ severity = "info", title, description = "", fields = [] }) {
  const clamp = (s, n) => {
    s = String(s ?? "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  const embed = {
    title:       clamp(title, 256),
    description: clamp(description, 4096),
    color:       EMBED_COLORS[severity] ?? EMBED_COLORS.info,
    // F10: transport marker — every embed rides raw discordPost (curl), never OC
    footer:      { text: "via raw-webhook" },
  };
  const fs = (fields || [])
    .filter(f => f && f.value)
    .slice(0, 25)
    .map(f => ({ name: clamp(f.name, 256), value: clamp(f.value, 1024) }));
  if (fs.length) embed.fields = fs;
  let total = embed.title.length + embed.description.length +
    embed.footer.text.length +
    fs.reduce((a, f) => a + f.name.length + f.value.length, 0);
  if (total > 6000) {
    const keep = Math.max(0, embed.description.length - (total - 6000) - 1);
    total -= embed.description.length;
    embed.description = keep ? embed.description.slice(0, keep) + "…" : "";
    total += embed.description.length;
  }
  while (total > 6000 && fs.length) {
    const dropped = fs.pop();
    total -= dropped.name.length + dropped.value.length;
  }
  if (embed.fields && !fs.length) delete embed.fields;
  return embed;
}

function buildInjectionEmbed(contactName, messageText) {
  return buildNoticeEmbed({
    severity:    "injection",
    title:       "⚠️ Prompt injection attempt",
    description: `From **${contactName}**\n\`${(messageText || "").slice(0, 100)}\``,
    fields:      [{ name: "Action", value: "message dropped, no draft, no reply sent" }],
  });
}

// cause: "max-alerts" (3 unanswered reposts) | "timeout" (4 waking hours)
function buildAutoDenyEmbed({ contactName, phone, lastMessage, cause }) {
  const why = cause === "timeout"
    ? "no approval after 4h"
    : `after ${MAX_UNKNOWN_ALERTS} unanswered alerts`;
  return buildNoticeEmbed({
    severity:    "autodeny",
    title:       `🚫 Auto-denied ${contactName || `+${phone}`}`,
    description: `\`+${phone}\` — ${why}`,
    fields: [
      { name: "Last message", value: lastMessage ? `"${lastMessage.slice(0, 120)}"` : "" },
      { name: "Reverse",      value: `remove from data/ghost-denylist.json, then \`ghost retrigger +${phone}\`` },
    ],
  });
}

// kind: "Short code" | "Transactional"
function buildTransactionalEmbed({ kind, phone, messageText }) {
  return buildNoticeEmbed({
    severity:    "transactional",
    title:       `ℹ️ ${kind} auto-denied`,
    description: `\`+${phone}\` — no reply path.\n💬 "${(messageText || "").slice(0, 160)}"`,
    fields:      [{ name: "Wrong call?", value: `remove from data/ghost-denylist.json, then \`ghost retrigger +${phone}\`` }],
  });
}

function buildExpiryEmbed(contactName, minutes) {
  return buildNoticeEmbed({
    severity:    "expiry",
    title:       "⏳ Draft expired unsent",
    description: `**${contactName}** — no Send tap within ${minutes} min.`,
  });
}

function buildCancelEmbed(contactName, reason = null) {
  return buildNoticeEmbed({
    severity:    "expiry",
    title:       "❌ Draft cancelled",
    description: `**${contactName}**${reason ? ` — ${reason}` : ""}`,
  });
}

// Raw-webhook fallback of the unknown-contact alert (OC gateway down → no
// buttons anyway). The prebuilt alert content — coalesced quotes, alert count,
// approve/deny text commands — rides whole as the description.
function buildUnknownAlertEmbed(content) {
  return buildNoticeEmbed({
    severity:    "approval",
    title:       "⚠️ Unknown contact — approval needed",
    description: content,
  });
}

// Live unknown-contact approval requests: phone → { messageId, postedAt, alertCount, phone, messageText, contactName, source, recentQuotes }
const pendingUnknownAlerts = new Map();

// ═══════════════════════════════════════════════════════════════════════════
//  PENDING DRAFTS
// ═══════════════════════════════════════════════════════════════════════════

function loadPendingDrafts() {
  const d = loadJson(PENDING_DRAFTS_FILE, []);
  return Array.isArray(d) ? d : [];
}
function savePendingDrafts(drafts) { saveJson(PENDING_DRAFTS_FILE, drafts); }

/**
 * Post the draft summary to #ghost-openclaw and record it as pending. The decision itself
 * comes from the native approval card (awaitDraftApproval); this message has no buttons.
 * Returns the pending draft record, or null when there is no usable draft.
 */
async function postDraftToDiscord(draftResult, meta) {
  const { chatGuid, chatId, contact, contactName, messageText, arrivedAt, contextMessages, autoSendMs } = meta;
  const draftId    = crypto.randomBytes(4).toString("hex");
  const phone      = `+${normalizePhone(contact)}`;
  const safeName   = contactName.replace(/[*_`]/g, "\\$&");

  // Determine conv mode (STRANGER vs ACTIVE) from conv state
  const convStateAll  = loadConvState();
  const convEntry     = convStateAll[normalizePhone(contact)] || {};
  const isActiveConv  = convEntry.mode === "active" &&
    convEntry.lastGhostSendAt &&
    (Date.now() - new Date(convEntry.lastGhostSendAt).getTime()) <= ACTIVE_TIMEOUT_MS;
  const convMode      = isActiveConv ? "ACTIVE" : "STRANGER";

  // Service type
  const service = (chatGuid || "").startsWith("SMS") ? "SMS" : "iMessage";

  // ── Build content ────────────────────────────────────────────────────────
  let content = `📱 **${safeName}** · ${phone} · ${service}\n`;
  content += `${"—".repeat(32)}\n`;

  // Their message
  content += `\n**Their message**\n> ${(messageText || "(no text)").slice(0, 300)}\n`;

  // Context (last 4 messages, chronological)
  const ctxMsgs = (contextMessages || [])
    .filter(m => m.text?.trim())
    .slice(0, 4)
    .reverse();
  if (ctxMsgs.length) {
    content += `\n**Context** (${ctxMsgs.length})\n`;
    for (const m of ctxMsgs) {
      const label = isFromKlein(m) ? "You" : contactName;
      content += `> **${label}**: ${m.text.trim().slice(0, 120)}\n`;
    }
  }

  const isSafetyBlocked = draftResult && draftResult.model === "safety-blocked";
  const isExhausted     = draftResult && draftResult.model === "exhausted";
  const hasUsableDraft  = draftResult && draftResult.text && !isSafetyBlocked && !isExhausted;

  if (hasUsableDraft) {
    const windowMin  = Math.round((autoSendMs || AUTO_SEND_WINDOW_MS) / 60000 * 10) / 10;
    const draftLines = draftResult.text.split("\n").map(l => `> ${l}`).join("\n");
    const usage = draftResult.usage;
    let usageStr = "";
    if (usage) {
      const pt = usage.prompt_tokens || 0;
      const ct = usage.completion_tokens || 0;
      const tt = usage.total_tokens || (pt + ct);
      const cost = typeof usage.cost === "number" ? usage.cost
        : typeof usage?.["x-ratelimit-cost"] === "number" ? usage["x-ratelimit-cost"] : null;
      const costStr = cost !== null ? ` · $${cost.toFixed(5)}` : "";
      usageStr = ` · ${tt}tok (↑${pt} ↓${ct})${costStr}`;
    }
    content += `\n**Draft** · _${draftResult.model}_${usageStr} · ${convMode}\n${draftLines}\n`;
    content += `\n⏳ Allow Once / Deny on the approval card below — expires unsent in ${windowMin} min · \`${draftId}\``;
  } else if (isSafetyBlocked) {
    content += `\n⚠️ All draft tiers failed content safety — reply manually.`;
  } else if (isExhausted) {
    const fl = (draftResult.failures || []).slice(0, 6).map(f => `> ${f}`).join("\n");
    content += `\n⚠️ No draft model available — reply manually.\n${fl}`;
  } else {
    content += `\n⚠️ Draft generation failed — reply manually.`;
  }

  // Hard cap at 1900 chars
  if (content.length > 1900) content = content.slice(0, 1897) + "…";

  const posted = await discordPost(GHOST_CHANNEL, { content });
  if (!hasUsableDraft) return null;

  const draft = {
    messageId:   posted?.id || null,
    draftId,
    chatGuid:    chatGuid || "",
    chatId:      Number.isInteger(chatId) ? chatId : null,
    contact:     contact  || "",
    contactName: contactName,
    draftText:   draftResult.text,
    arrivedAt:   new Date(arrivedAt).toISOString(),
    postedAt:    new Date().toISOString(),
    autoSendMs:  autoSendMs || AUTO_SEND_WINDOW_MS,
  };
  const drafts = loadPendingDrafts();
  drafts.push(draft);
  savePendingDrafts(drafts);
  log(`Pending draft saved: ${contactName} (${draftId})`);
  return draft;
}

async function postUnknownAlert(phone, messageText, contactName, { source = "unknown", alertCount = 1, recentQuotes = null } = {}) {
  const n        = normalizePhone(phone);
  const inApple  = source === "apple_contacts";
  const nameDisp = inApple ? `**${contactName}** (+${n})` : `+${n}`;
  const quotes   = (recentQuotes && recentQuotes.length ? recentQuotes : [messageText]).filter(Boolean).slice(-3);

  // Register first, before any await, so a second message coalesces onto this request.
  pendingUnknownAlerts.set(n, {
    messageId: null, postedAt: Date.now(), alertCount,
    phone: n, messageText, contactName, source, recentQuotes: quotes,
  });

  let content = `⚠️ **Unknown Contact** (${inApple ? "in your Contacts" : "not in Contacts"})\n`;
  content += `📞 ${nameDisp}\n`;
  content += inApple ? "📒 Found in your Apple Contacts\n" : "❓ Not in Apple Contacts\n";
  for (const q of quotes) content += `💬 "${(q || "").slice(0, 200)}"\n`;
  content = content.trimEnd();
  if (alertCount > 1) content += `\n_Request #${alertCount} — ${MAX_UNKNOWN_ALERTS - alertCount} more unanswered before auto-deny_`;
  content += "\nAllow Once adds the number to the allowlist; Deny adds it to the denylist (approval card below).";

  const posted = await discordPost(GHOST_CHANNEL, { embeds: [buildUnknownAlertEmbed(content)] });
  const entry  = pendingUnknownAlerts.get(n);
  if (entry) entry.messageId = posted?.id || null;

  const title = `Ghost: allow drafting for ${inApple ? contactName.slice(0, 30) : `+${n}`}?`.slice(0, imsg.APPROVAL_TITLE_MAX);
  const description = [
    `+${n} · ${inApple ? `${contactName} (in Contacts)` : "not in Contacts"}`,
    ...quotes.map(q => `"${(q || "").slice(0, 200)}"`),
  ].join("\n").slice(0, imsg.APPROVAL_DESCRIPTION_MAX);
  const { decision, error } = await transport.requestApproval({
    title, description, timeoutMs: UNKNOWN_APPROVAL_MS, channelId: GHOST_CHANNEL,
  });
  if (error) log(`Unknown-contact approval for +${n} failed: ${error}`);
  return resolveUnknownContactDecision(n, decision);
}

// ═══════════════════════════════════════════════════════════════════════════
//  OWNER APPROVAL  (native plugin approvals — Discord card in #ghost-openclaw, /approve)
// ═══════════════════════════════════════════════════════════════════════════

const APPROVAL_MIN_WINDOW_MS = 60 * 1000;

/**
 * Ask the owner about one draft and act on the answer. The approval description is the
 * exact draft text: the owner approves the string that is sent, never a draft id that
 * could resolve to something else later. A draft longer than the card allows is refused,
 * not truncated.
 */
async function awaitDraftApproval(draft) {
  const text = draft.draftText || "";
  if (text.length > imsg.APPROVAL_DESCRIPTION_MAX) {
    return resolveDraftDecision(draft.draftId, null, null, "too-long");
  }
  const target = `+${normalizePhone(draft.contact)}`;
  const name   = (draft.contactName || target).slice(0, 30);
  const title  = `Ghost: send to ${name} (${target})?`.slice(0, imsg.APPROVAL_TITLE_MAX);
  const windowMs = Math.max(draft.autoSendMs || AUTO_SEND_WINDOW_MS, APPROVAL_MIN_WINDOW_MS);
  const { decision, error } = await transport.requestApproval({
    title, description: text, timeoutMs: windowMs, channelId: GHOST_CHANNEL,
  });
  if (error) log(`Approval request for draft ${draft.draftId} failed: ${error}`);
  return resolveDraftDecision(draft.draftId, decision, text, error ? "approval-error" : null);
}

/**
 * Apply one owner decision. Fail-closed rules (a live approval cannot be withdrawn from
 * another connection, so a late "allow-once" must be safe):
 *   - the draft must still be pending: superseded, cancelled (Klein replied by hand) or
 *     paused drafts are gone from the pending file, and are not sent;
 *   - one approval gives one send attempt: the draft leaves the pending file first;
 *   - the approved text must equal the pending draft text;
 *   - no decision (expiry, error, oversized draft) is never a send (AUTOSEND-FAILCLOSED).
 */
async function resolveDraftDecision(draftId, decision, approvedText, note = null) {
  const draft = loadPendingDrafts().find(d => d.draftId === draftId);
  if (!draft) {
    log(`Decision ${decision || "none"} for ${draftId}: draft no longer pending (superseded, cancelled or paused) — not sent`);
    return { action: "stale" };
  }
  savePendingDrafts(loadPendingDrafts().filter(d => d.draftId !== draftId));

  if (cancelledDraftIds.has(draftId)) {
    cancelledDraftIds.delete(draftId);
    cancelledDraftTtl.delete(draftId);
    logFeedback(draft, "cancelled");
    return { action: "cancelled" };
  }

  if (decision === "allow-once") {
    if (approvedText !== draft.draftText) {
      log(`Approval for ${draftId} does not match the pending text — not sent`);
      logFeedback(draft, "blocked-text-mismatch");
      await discordPost(GHOST_CHANNEL, { content: `🚫 Blocked send to **${draft.contactName}**: approved text differs from the draft.` });
      return { action: "text_mismatch" };
    }
    log(`✅ Approved: ${draft.contactName} (${draftId})`);
    const ok = await executeSend({ ...draft, draftText: approvedText }, "approval:allow-once");
    return { action: ok ? "handled" : "send_failed" };
  }

  if (decision === "deny") {
    log(`❌ Denied: ${draft.contactName} (${draftId})`);
    logFeedback(draft, "cancelled");
    await discordPost(GHOST_CHANNEL, { embeds: [buildCancelEmbed(draft.contactName)] });
    return { action: "cancelled" };
  }

  if (note === "too-long") {
    log(`Draft ${draftId} for ${draft.contactName} exceeds the approval card (${imsg.APPROVAL_DESCRIPTION_MAX} chars) — refused`);
    logFeedback(draft, "refused-too-long");
    await discordPost(GHOST_CHANNEL, {
      content: `⚠️ Draft for **${draft.contactName}** is longer than the approval card allows (${imsg.APPROVAL_DESCRIPTION_MAX} chars) — not sent. Reply manually.`,
    });
    return { action: "refused_too_long" };
  }

  const minutes = Math.round((draft.autoSendMs || AUTO_SEND_WINDOW_MS) / 60000);
  log(`Draft expired unsent for ${draft.contactName} (${draftId}) reason=${note || "expired"}`);
  logFeedback(draft, "expired");
  await discordPost(GHOST_CHANNEL, { embeds: [buildExpiryEmbed(draft.contactName, minutes)] });
  return { action: "expired" };
}

/**
 * An approval lives in the process that requested it. After a restart no pending draft
 * can be approved any more, so each one expires unsent and the owner is told.
 */
function expireOrphanedDraftsOnStartup() {
  const drafts = loadPendingDrafts();
  if (!drafts.length) return;
  savePendingDrafts([]);
  for (const d of drafts) logFeedback(d, "expired-restart");
  const names = [...new Set(drafts.map(d => d.contactName))].join(", ");
  log(`Startup: ${drafts.length} pending draft(s) lost their approval on restart — expired unsent`);
  discordPost(GHOST_CHANNEL, {
    content: `⚠️ **Ghost restarted** — ${drafts.length} pending draft(s) expired unsent; their approval cards no longer act.\nAffected: ${names || "unknown"}\nReply manually if needed.`,
  }).catch(() => {});
}

/** Act on the owner's answer to "let ghost draft for this unknown number?". */
async function resolveUnknownContactDecision(phone, decision) {
  const n     = normalizePhone(phone);
  const entry = pendingUnknownAlerts.get(n) || { contactName: `+${n}`, alertCount: 1 };
  pendingUnknownAlerts.delete(n);

  if (decision === "allow-once") {
    const name = entry.source === "apple_contacts" ? entry.contactName : "Unknown";
    try {
      addToAllowlist(`+${n}`, name, { source: "discord_approve" });
    } catch (err) {
      log(`Approve skipped for +${n}: ${err.message}`);
      return { action: "error" };
    }
    unknownAlertCounts.delete(n);
    await discordPost(GHOST_CHANNEL, { content: `✅ Approved **${entry.contactName || `+${n}`}** — added to allowlist.` });
    return { action: "approved" };
  }

  if (decision === "deny") {
    addToDenylist(n);
    unknownAlertCounts.delete(n);
    await discordPost(GHOST_CHANNEL, { content: `🚫 Denied \`+${n}\` — added to denylist.` });
    return { action: "denied" };
  }

  const count = entry.alertCount || 1;
  unknownAlertCounts.set(n, count);
  if (count >= MAX_UNKNOWN_ALERTS) {
    log(`Unknown contact +${n}: ${count} unanswered approval requests — auto-denying`);
    addToDenylist(n);
    unknownAlertCounts.delete(n);
    discordPost(GHOST_CHANNEL, {
      embeds: [buildAutoDenyEmbed({ contactName: entry.contactName, phone: n, lastMessage: entry.messageText, cause: "max-alerts" })],
    }).catch(() => {});
    return { action: "auto_denied" };
  }
  log(`Unknown contact +${n}: approval expired unanswered (${count}/${MAX_UNKNOWN_ALERTS})`);
  return { action: "expired" };
}

// Unanswered approval requests for one unknown number before it is auto-denied
const MAX_UNKNOWN_ALERTS = 3;
// An unknown-contact approval stays open for the plugin-approval maximum
const UNKNOWN_APPROVAL_MS = imsg.APPROVAL_TIMEOUT_MAX_MS;

// Refresh unknown-contact alerts before Discord's 15-min interaction token expires.
// Runs every 12 min; deletes stale message + reposts fresh one for any unanswered alert.
// After MAX_UNKNOWN_ALERTS reposts, auto-denies the contact to stop the spam loop.


// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 0 — PREFLIGHT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * runPreflight(contact, messageText, chatGuid, eventData)
 *
 * Consolidates all Phase 0 checks. Short-circuits on first failure.
 * Unknown contact flow (check 4) triggers postUnknownAlert as a side effect.
 * On success, pre-fetches 10 recent messages and returns contact context.
 *
 * Returns:
 *   { ok: true,  context: { messages, contactName, category } }
 *   { ok: false, reason: string, ...extra }
 */
const MAX_MESSAGE_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours — drops backlog replayed after a resume

async function runPreflight(contact, messageText, chatGuid, eventData) {
  const normalized = normalizePhone(contact);

  // -2. Reaction-event guard — skip tapback/emoji reactions without further processing
  // (imsg watch.subscribe runs with include_reactions, so tapbacks arrive as messages)
  if (eventData?.type === "reaction" || eventData?.isReaction === true) {
    return { ok: false, reason: "reaction_event" };
  }

  // -1. Age gate — skip messages older than 2 hours (a since_rowid resume replays backlog)
  const msgDateCreated = eventData?.dateCreated ?? eventData?.date_created ?? 0;
  const msgAgeMs = msgDateCreated ? (Date.now() - normalizeTs(msgDateCreated)) : 0;
  if (msgDateCreated && msgAgeMs > MAX_MESSAGE_AGE_MS) {
    log(`Message from +${normalized} is ${Math.round(msgAgeMs / 60000)}min old — skipping (age gate)`);
    return { ok: false, reason: "message_too_old" };
  }

  // 0. Prompt injection scan — must come before any processing of message content
  const injCheck = scanForInjection(messageText);
  if (!injCheck.safe) {
    const { numToAlias, numToName } = loadContactsMap();
    const contactName = numToAlias[normalized] || numToName[normalized] || `+${normalized}`;
    log(`Prompt injection detected from ${contactName}: ${(messageText || "").slice(0, 80)}`);
    // Fire-and-forget Discord alert — include message text so Klein can see the attempt
    discordPost(GHOST_CHANNEL, {
      embeds: [buildInjectionEmbed(contactName, messageText)],
    }).catch(() => {});
    return { ok: false, reason: "prompt_injection" };
  }

  // 0.5. Sanitize — strip URLs, attachment markers, media filenames.
  // If nothing substantive remains (pure media message), skip silently.
  const sanitizedText = sanitizeMessageText(messageText);
  if (!sanitizedText) {
    log(`Media/URL-only message from +${normalized} — skipping (no text content)`);
    return { ok: false, reason: "media_only" };
  }

  // 1. requiresReply — skip no-op acks, emoji-only, tapbacks, sensitive content
  // Use sanitized text so URL-only or attachment-only messages don't get drafted
  if (!requiresReply(sanitizedText)) {
    return { ok: false, reason: "no_reply_needed" };
  }

  // 2. isLikelySpam — keyword, url, short-code, rate-limit checks
  if (isLikelySpam(normalized, sanitizedText)) {
    return { ok: false, reason: "spam" };
  }

  // 3. isDenied — explicit denylist
  if (isDenied(contact)) {
    return { ok: false, reason: "denied" };
  }

  // 4. isAllowed check + unknown contact flow
  if (!isAllowed(contact)) {
    // Apple Contacts name: imsg resolves the sender against Contacts (sender_name). A
    // sender_name that is only the number again means "not in Contacts".
    const senderName = typeof eventData?.senderName === "string" ? eventData.senderName.trim() : "";
    const appleContactName = senderName && normalizePhone(senderName) !== normalized ? senderName : null;
    const alertSource = appleContactName ? "apple_contacts" : "unknown";
    const { numToAlias } = loadContactsMap();
    const displayName = appleContactName || numToAlias[normalized] || `+${normalized}`;

    // F5 — short codes and transactional senders cannot be "approved" into a conversation:
    // give them an FYI notice with no approve/deny ask and deny immediately instead of
    // letting them ride the 3-alert + 4h auto-deny loop. Only for numbers NOT in Contacts.
    const isShortCode     = normalized.length < 7;
    const isTransactional = alertSource === "unknown" &&
      /\b(txn|transaction #|receipt|reminder:|appointment at|verification code|one[- ]time (code|passcode)|your (transfer|order|package|payment)|do not reply|unsubscribe|reply STOP)\b/i
        .test(messageText || "");
    if (isShortCode || isTransactional) {
      addToDenylist(normalized);
      discordPost(GHOST_CHANNEL, {
        embeds: [buildTransactionalEmbed({ kind: isShortCode ? "Short code" : "Transactional", phone: normalized, messageText })],
      }).catch(() => {});
      return { ok: false, reason: "transactional_sender", resolvedName: displayName };
    }

    // F1 — coalesce: one live approval request per contact. A live request cannot be
    // edited, so a further message only joins its quotes; the next request (after this
    // one expires) carries them.
    const existing = pendingUnknownAlerts.get(normalized);
    if (existing) {
      existing.recentQuotes = [...(existing.recentQuotes || []), messageText].filter(Boolean).slice(-3);
      return { ok: false, reason: "unknown_contact", resolvedName: displayName, source: alertSource, coalesced: true };
    }

    // Fire-and-forget — the approval request blocks for up to 10 minutes
    postUnknownAlert(normalized, messageText, displayName, {
      source:     alertSource,
      alertCount: (unknownAlertCounts.get(normalized) || 0) + 1,
      recentQuotes: [messageText],
    }).catch(err => log(`postUnknownAlert error for +${normalized}: ${err.message}`));
    return { ok: false, reason: "unknown_contact", resolvedName: displayName, source: alertSource };
  }

  // 5. isGroupChatGuid — skip group threads
  // CRITICAL: Ghost must never reply to an individual if the message came from a group chat context.
  if (isGroupChatGuid(chatGuid, eventData)) {
    return { ok: false, reason: "group_chat", groupChatSender: true };
  }

  // 6. isQuietHours — per-contact-category quiet window
  if (isQuietHours(contact)) {
    return { ok: false, reason: "quiet_hours" };
  }

  // 7. fetchRecentMessages — build context upfront, attach to pending entry
  const messages = await fetchRecentMessages(eventData?.chatId, 10);
  const { numToName, numToAlias, numToCategory } = loadContactsMap();
  const contactName = numToAlias[normalized] || numToName[normalized] || `+${normalized}`;
  const category    = numToCategory[normalized] || "friend";

  // 8. Klein recently active gate — if Klein replied in the last 10 min, skip drafting.
  //    This prevents ghost from drafting into an active conversation Klein is handling.
  const arrivedAt  = Date.now();
  const tenMinAgo  = arrivedAt - 10 * 60 * 1000;
  const kleinRecentlyActive = messages.some(m =>
    (m.isFromMe === true || m.from === "me") &&
    normalizeTs(m.dateCreated) > tenMinAgo &&
    normalizeTs(m.dateCreated) < arrivedAt
  );
  if (kleinRecentlyActive) {
    log(`Klein recently active in chat with ${contactName} — skipping draft`);
    return { ok: false, reason: "klein_recently_active" };
  }

  return { ok: true, context: { messages, contactName, category, sanitizedText } };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CORE DRAFT LOGIC
// ═══════════════════════════════════════════════════════════════════════════

// In-memory map: key (chatGuid|phone) → { contact, contactName, messageText, chatGuid, arrivedAt, timeoutId, contextMessages }
const pendingMessages = new Map();
// cancelledDraftIds declared at top of file (line ~65)

async function checkAndDraft(key) {
  const entry = pendingMessages.get(key);
  if (!entry) return;
  const { contact, contactName, messageText, sanitizedText, chatGuid, chatId, arrivedAt, autoSendMs } = entry;
  // Use sanitized text for model (strips links, media, secrets) — show original in Discord
  const modelText = sanitizedText || messageText;
  pendingMessages.delete(key);

  log(`checkAndDraft: ${contactName} (${key})`);

  // Quiet hours guard — don't draft outside 8am–11pm ET (uses existing isQuietHours)
  if (isQuietHours(contact)) {
    log(`checkAndDraft: quiet hours — skipping draft for ${contactName}`);
    return;
  }

  // Every read and the send-time collision check need the imsg chat id. Without it the
  // send would be blocked anyway (kleinRepliedSince fails closed), so do not draft.
  if (!Number.isInteger(chatId)) {
    log(`checkAndDraft: no imsg chat id for ${contactName} — draft aborted`);
    await discordPost(GHOST_CHANNEL, {
      content: `⚠️ **${contactName}**: the iMessage thread could not be identified — no draft. Reply manually.`,
    });
    return;
  }

  // Collision check — did Klein reply during the window?
  const recent = await fetchRecentMessages(chatId, 10);
  if (recent.some(m => isFromKlein(m) && normalizeTs(m.dateCreated || 0) > arrivedAt)) {
    log(`Klein already replied to ${contactName} — skipping draft`);
    return;
  }

  // Phase 3: live context — last 20 messages fetched at draft time
  const contextMessages = await fetchRecentMessages(chatId, 20);

  // Index fetched messages into embedding DB (non-blocking)
  for (const m of contextMessages) {
    if (m.text?.trim()) {
      const role = (m.isFromMe === true || m.from === "me") ? "me" : "them";
      indexMessage(contact, m.dateCreated || Date.now(), role, m.text.trim());
    }
  }

  // Build prompt + generate via full failover chain
  // Use sanitized (model-safe) text for prompt building; original shown in Discord post
  const systemPrompt = await buildSystemPrompt(contactName, contact, modelText);
  const userContent  = buildUserContent(contactName, modelText, contextMessages, arrivedAt);
  const historyLines = contextMessages
    .filter(m => m.text?.trim())
    .slice().reverse()
    .map(m => `${m.isFromMe ? "Klein" : contactName}: ${m.text.trim().slice(0, 150)}`)
    .join("\n");

  const draftResult = await generateDraft(systemPrompt, userContent, {
    contactName, contactPhone: contact, messageText: modelText, historyLines,
  });

  // Cannot-answer gate: if model returned [CANNOT_ANSWER: ...], alert and abort
  if (draftResult && draftResult.text && draftResult.text.trimStart().startsWith("[CANNOT_ANSWER:")) {
    const match  = draftResult.text.match(/^\[CANNOT_ANSWER:\s*(.*?)\]/s);
    const reason = match ? match[1].trim() : "unknown reason";
    log(`[ghost] Cannot-answer gate: ${contactName} asked something I cannot answer`);
    await postCannotAnswerAlert(contactName, messageText, reason);
    return;
  }

  const draft = await postDraftToDiscord(draftResult, {
    chatGuid, chatId, contact, contactName, messageText, arrivedAt, contextMessages, autoSendMs,
  });
  if (draft) await awaitDraftApproval(draft);
}

// ═══════════════════════════════════════════════════════════════════════════
//  SEND HELPERS  (used after an owner approval)
// ═══════════════════════════════════════════════════════════════════════════

/** "iMessage;-;+15551234567" (any service prefix) → "+15551234567"; null for anything else. */
function dmPhoneFromChatGuid(chatGuid) {
  const m = typeof chatGuid === "string" && chatGuid.match(/^[A-Za-z]+;-;(\+?\d+)$/);
  return m ? m[1] : null;
}

async function sendIMessage(target, message) {
  // ── G10: the single outbound chokepoint ──
  // Layer order is the phase 90 contract: send toggle → style allowlist → empty →
  // drift markers → recipient allowlist. Only then does the native channel send.
  const toggle = ghostSendToggleState();
  if (!toggle.enabled) {
    log(`sendIMessage BLOCKED fail-closed: send toggle ${toggle.reason || "off"} for ${target || "unknown-target"}`);
    return false;
  }
  const styleViolation = styleAllowlistViolation(message);
  if (styleViolation) {
    log(`sendIMessage BLOCKED style-allowlist (${styleViolation}) for ${target || "unknown-target"}`);
    return false;
  }

  const normalizedMessage = (message || "").toString().trim();
  if (!normalizedMessage) {
    log("sendIMessage blocked: empty outbound message");
    return false;
  }

  if (hasInternalDriftMarkers(normalizedMessage)) {
    log(`sendIMessage BLOCKED internal/pipeline marker for ${target || "unknown-target"}`);
    return false;
  }

  // Recipient allowlist, mandatory. Only an E.164 handle that is on the ghost allowlist,
  // or the owner, can receive. A chat id, guid, email handle or group cannot be checked
  // against the phone-only allowlist, so it is never sent to.
  if (typeof target !== "string" || !imsg.E164.test(target)) {
    log(`sendIMessage BLOCKED: target ${String(target).slice(0, 40)} is not an E.164 handle`);
    return false;
  }
  if (!isAllowed(target) && normalizePhone(target) !== OWNER_PHONE_NORMALIZED) {
    log(`sendIMessage BLOCKED: recipient ${target} not in contact allowlist`);
    return false;
  }

  const r = await transport.sendIMessage(target, message);
  if (r && r.ok) return true;
  log(`sendIMessage native send failed for ${target}: ${(r && r.error) || "unknown error"}`);
  return false;
}

async function kleinRepliedSince(chatId, sinceIso) {
  // Collision guard before a send. Fail closed: a thread that cannot be read counts as
  // "Klein replied", so nothing is sent on top of a reply ghost could not see.
  if (!Number.isInteger(chatId)) {
    log("kleinRepliedSince: no chat id — blocking send");
    return true;
  }
  try {
    const sinceMs  = new Date(sinceIso).getTime() - 30000; // 30s buffer
    const messages = await imsgHistory(chatId, 30, 15000);
    return messages.some(m => m.isFromMe && m.dateCreated > sinceMs);
  } catch (err) {
    log(`kleinRepliedSince check failed (blocking send): ${(err.message || "").slice(0, 80)}`);
    return true;
  }
}

// Public wrapper — acquires per-contact send lock before calling inner logic
async function executeSend(draft, reason) {
  return withContactSendLock(draft.contact || draft.chatGuid || "", () => _executeSend(draft, reason));
}

async function _executeSend(draft, reason) {
  const { contactName, chatGuid, chatId, draftText, arrivedAt, postedAt, contact } = draft;

  if (!draftText) {
    log(`[${reason}] Empty draft for ${contactName} — skipping`);
    await discordPost(GHOST_CHANNEL, { content: `⚠️ Skipped **${contactName}**: draft was empty.` });
    return true; // remove from pending
  }

  if (isPaused()) {
    log(`[${reason}] BLOCKED while paused for ${contactName}`);
    await discordPost(GHOST_CHANNEL, { content: `⏸ Blocked send to **${contactName}**: Ghost is paused.` });
    logFeedback(draft, "blocked-paused");
    return true;
  }

  // The draft was generated for `contact` (their memory + history); never deliver it to a
  // different thread. A webhook carrying one contact's handle with another chat's guid
  // would otherwise route that context to the wrong person.
  const guidPhone = dmPhoneFromChatGuid(chatGuid);
  if (contact && guidPhone && normalizePhone(guidPhone) !== normalizePhone(contact)) {
    log(`[${reason}] BLOCKED recipient mismatch for ${contactName}: ${chatGuid} ≠ ${contact}`);
    await discordPost(GHOST_CHANNEL, { content: `🚫 Blocked send to **${contactName}**: chat does not match contact.` });
    logFeedback(draft, "blocked-recipient-mismatch");
    return true;
  }

  if (isDenied(contact || chatGuid)) {
    log(`[${reason}] BLOCKED denylist for ${contactName}`);
    await discordPost(GHOST_CHANNEL, { content: `🚫 Blocked send to **${contactName}**: contact is denylisted.` });
    logFeedback(draft, "blocked-denylist");
    return true;
  }

  // Recipient check before the rate gate: the target is the draft's own contact as an
  // E.164 handle, and it must be allowlisted (or the owner). sendIMessage repeats this.
  const target = `+${normalizePhone(contact || "")}`;
  if (!imsg.E164.test(target) || (!isAllowed(target) && normalizePhone(target) !== OWNER_PHONE_NORMALIZED)) {
    log(`[${reason}] BLOCKED recipient ${target} for ${contactName}: not an allowlisted E.164 handle`);
    await discordPost(GHOST_CHANNEL, { content: `🚫 Blocked send to **${contactName}**: recipient is not an allowlisted phone number.` });
    logFeedback(draft, "blocked-recipient");
    return true;
  }

  // ── In-memory collision check (fix #6: prevents "cancelled but sent anyway" race) ──────
  // Cheaper than the history read below, and catches an is_from_me row that arrived
  // while the approval card was open.
  const chatKey  = chatGuid || "";
  const normKey  = normalizePhone(contact || "");
  const inMemTs  = kleinRepliedRecentlyChats.get(chatKey) || kleinRepliedRecentlyChats.get(normKey);
  if (inMemTs && Date.now() - inMemTs < 30 * 60 * 1000) {
    log(`[${reason}] Klein replied recently (in-memory) for ${contactName} — skipping`);
    await discordPost(GHOST_CHANNEL, { content: `ℹ️ Skipped **${contactName}** — Klein already replied.` });
    return true;
  }

  // Late collision check — use arrivedAt (when contact's message arrived) so we catch
  // cases where Klein replied manually BEFORE ghost even generated the draft.
  const collisionAnchor = arrivedAt || postedAt;
  if (collisionAnchor && await kleinRepliedSince(chatId, collisionAnchor)) {
    log(`[${reason}] Klein already replied to ${contactName} — skipping`);
    await discordPost(GHOST_CHANNEL, { content: `ℹ️ Skipped **${contactName}** — Klein already replied.` });
    return true;
  }

  if (hasInternalDriftMarkers(draftText)) {
    log(`[${reason}] BLOCKED internal/pipeline marker in draft for ${contactName}`);
    await discordPost(GHOST_CHANNEL, { content: `🚫 Blocked send to **${contactName}**: internal pipeline text detected.` });
    logFeedback(draft, "blocked-internal-marker");
    return true;
  }

  const rate = outboundRateGate(contact, chatGuid);
  if (!rate.ok) {
    log(`[${reason}] BLOCKED send to ${contactName}: ${rate.reason} (backoff level ${rate.backoffLevel ?? 0})`);
    const lvl = rate.backoffLevel ?? 0;
    if (rate.shouldPause) {
      // Backoff maxed out — something is wrong, stop Ghost entirely
      log(`[${reason}] Adaptive backoff reached level ${lvl} for ${contactName} — triggering emergency pause`);
      cmdPause([]);
      await discordPost(GHOST_CHANNEL, { content: `🚨 **Ghost emergency pause**: repeated rate-limit escalation for **${contactName}** (level ${lvl}). Ghost stopped. Run \`ghost resume\` to restart.` });
    } else if (lvl >= 3) {
      await discordPost(GHOST_CHANNEL, { content: `⚠️ **Rate-limit escalation** (level ${lvl}) for **${contactName}**: ${rate.reason}. Backoff window now ${Math.round(BACKOFF_BASE_MS * Math.pow(2, lvl) / 60000)}min. Check for runaway sends.` });
    } else if (lvl >= 1) {
      await discordPost(GHOST_CHANNEL, { content: `⚠️ Rate-limit (level ${lvl}) for **${contactName}**: ${rate.reason}` });
    } else {
      await discordPost(GHOST_CHANNEL, { content: `🚫 Blocked send to **${contactName}**: ${rate.reason}` });
    }
    logFeedback(draft, "blocked-rate-limit");
    return true;
  }

  log(`[${reason}] Sending to ${contactName}: "${draftText.slice(0, 60)}..."`);
  const ok = await sendIMessage(target, draftText);

  if (ok) {
    await discordPost(GHOST_CHANNEL, { content: `✅ Sent to **${contactName}**: "${draftText}"` });
    logFeedback(draft, "sent");
    // Index outgoing message into embedding DB (non-blocking)
    indexMessage(contact, Date.now(), "me", draftText);
    // Update conversation state machine
    onGhostSend(contact);
    return true;
  }
  // One approval, one attempt: a failed send is reported, never retried.
  log(`Send failed for ${contactName} — not retried`);
  logFeedback(draft, "send-failed");
  await discordPost(GHOST_CHANNEL, { content: `❌ Send to **${contactName}** failed — not retried. Reply manually.` });
  return false;
}


// ═══════════════════════════════════════════════════════════════════════════
//  HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════

function isLoopbackAddress(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function requestHasValidToken(req, token = GHOST_API_TOKEN) {
  if (!token) return false;
  const auth   = String(req.headers?.authorization || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  let query = "";
  try { query = new URL(req.url || "/", "http://localhost").searchParams.get("token") || ""; } catch {}
  const expected = Buffer.from(token);
  return [bearer, String(req.headers?.["x-ghost-token"] || ""), query].some(candidate => {
    const got = Buffer.from(candidate);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

function isAuthorizedRequest(req, scope, token = GHOST_API_TOKEN) {
  if (scope === "control") return isLoopbackAddress(req.socket?.remoteAddress) || requestHasValidToken(req, token);
  return true;
}

/**
 * Local status server. Inbound arrives over imsg rpc and decisions over native approvals,
 * so nothing here changes state: /health is public, /pending is loopback or token.
 */
function createServer() {
  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let pathname = "/";
    try { pathname = new URL(req.url || "/", "http://localhost").pathname; } catch {}
    const scope = pathname === "/pending" ? "control" : "public";
    if (!isAuthorizedRequest(req, scope)) {
      log(`Rejected unauthorized ${req.method} ${pathname} from ${req.socket?.remoteAddress || "?"}`);
      return send(401, { ok: false, error: "unauthorized" });
    }

    if (req.method === "GET" && pathname === "/health") {
      return send(200, {
        ok: true, service: "ghost-v3", transport: "imessage-native",
        imsg: imsgWatch ? (imsgWatch.getClient() ? "connected" : "reconnecting") : "off",
        paused: isPaused(), sendEnabled: ghostSendToggleState().enabled,
        pending: pendingMessages.size, awaitingApproval: loadPendingDrafts().length,
      });
    }

    if (req.method === "GET" && pathname === "/pending") {
      const list = [...pendingMessages.entries()].map(([k, v]) => ({
        key: k, contactName: v.contactName,
        arrivedAt: new Date(v.arrivedAt).toISOString(),
        firesAt:   new Date(v.arrivedAt + DRAFT_DELAY_MS).toISOString(),
      }));
      const drafts = loadPendingDrafts().map(d => ({ draftId: d.draftId, contactName: d.contactName, postedAt: d.postedAt }));
      return send(200, { ok: true, pending: list, awaitingApproval: drafts });
    }

    send(404, { ok: false, error: "Not found" });
  });
}

/**
 * One inbound iMessage (normalized by imsg.normalizeImsgMessage) through the gates.
 * Returns the outcome object the old webhook route answered with.
 */
async function handleInboundMessage(msg) {
  try {
    const eventData = (msg && typeof msg === "object") ? msg : {};
    const isFromMe  = eventData.isFromMe === true;
    const chatGuid  = typeof eventData.chatGuid === "string" ? eventData.chatGuid : "";
    const chatId    = Number.isInteger(eventData.chatId) ? eventData.chatId : null;
    const contact   = extractContactPhone(eventData);

    if (isGroupChatGuid(chatGuid, eventData)) {
      log(`Group chat — skipping (chatGuid: ${chatGuid || "none"})`);
      return { ok: true, action: "ignored", reason: "group_chat" };
    }

    const normalized = normalizePhone(contact);

    if (isDuplicateInboundEvent("imsg", eventData)) {
      log(`Duplicate inbound event dropped for ${normalized || chatGuid || "unknown"}`);
      return { ok: true, action: "ignored", reason: "duplicate_event" };
    }

    // Outgoing: Klein sent a message — cancel pending work for this chat
    if (isFromMe || normalized === OWNER_PHONE_NORMALIZED) {
      const key = chatGuid || normalized;
      let cancelled = false;

      const replyTs = Date.now();
      if (key)        kleinRepliedRecentlyChats.set(key, replyTs);
      if (normalized) kleinRepliedRecentlyChats.set(normalized, replyTs);
      for (const [k, ts] of kleinRepliedRecentlyChats.entries()) {
        if (replyTs - ts > 30 * 60 * 1000) kleinRepliedRecentlyChats.delete(k);
      }

      // 1. Cancel in-memory pending (pre-draft, within the debounce window)
      if (key && pendingMessages.has(key)) {
        clearTimeout(pendingMessages.get(key).timeoutId);
        pendingMessages.delete(key);
        log(`Klein replied to ${key} — cancelled in-memory pending draft`);
        cancelled = true;
      }

      // 2. Cancel any posted draft for this chat. Its approval card stays live until it
      //    expires, but resolveDraftDecision finds no pending draft and sends nothing.
      const postedDrafts = loadPendingDrafts();
      const toCancel = postedDrafts.filter(d =>
        d.chatGuid === key ||
        (chatGuid && d.chatGuid === chatGuid) ||
        (normalized && normalizePhone(d.contact) === normalized)
      );
      if (toCancel.length > 0) {
        savePendingDrafts(postedDrafts.filter(d => !toCancel.includes(d)));
        for (const draft of toCancel) {
          cancelledDraftIds.add(draft.draftId);
          cancelledDraftTtl.set(draft.draftId, Date.now() + 30 * 60 * 1000);
          log(`Klein outgoing — cancelled posted draft ${draft.draftId} for ${draft.contactName}`);
          logFeedback(draft, "auto-cancelled-klein-replied");
          discordPost(GHOST_CHANNEL, {
            embeds: [buildCancelEmbed(draft.contactName, "Klein already replied")],
          }).catch(() => {});
        }
        cancelled = true;
      }

      return { ok: true, action: cancelled ? "draft_cancelled" : "outgoing_noop" };
    }

    if (!contact || !normalized) return { ok: true, action: "drop", reason: "no_contact" };

    const messageText = extractMessageText(eventData);

    // Paused means quiet: no preflight, so no unknown-number cards, alerts or drafts.
    // Outgoing rows above still cancel pending work.
    if (isPaused()) { log(`Paused — skipping ${normalized}`); return { ok: true, action: "paused" }; }

    const preflight = await runPreflight(contact, messageText, chatGuid, eventData);
    if (!preflight.ok) {
      log(`Preflight skip: ${preflight.reason} for ${normalized}`);
      if (preflight.reason === "unknown_contact") {
        return { ok: true, action: "unknown_contact_alert", resolvedName: preflight.resolvedName, source: preflight.source };
      }
      if (preflight.reason === "spam") {
        if (!isAllowed(contact)) { addToDenylist(normalized); log(`Auto-denied spam: ${normalized}`); }
        return { ok: true, action: "drop", reason: "auto_deny_spam" };
      }
      return { ok: true, action: preflight.reason };
    }

    const { contactName } = preflight.context;
    const arrivedAt = Date.now();
    const key       = chatGuid || normalized;

    // One posted draft per contact at a time.
    const postedDrafts = loadPendingDrafts();
    const activeDraft = postedDrafts.find(d =>
      normalizePhone(d.contact) === normalized || d.chatGuid === key || (chatGuid && d.chatGuid === chatGuid)
    );
    if (activeDraft) {
      log(`Existing posted draft ${activeDraft.draftId} for ${contactName} — skipping re-queue`);
      return { ok: true, action: "draft_already_posted", contactName, chatGuid: key, draftId: activeDraft.draftId };
    }

    // Debounce rapid messages: replace the queued entry for this chat
    if (pendingMessages.has(key)) {
      clearTimeout(pendingMessages.get(key).timeoutId);
      log(`Debounced pending for ${key}`);
    }

    onContactMessage(contact);
    indexMessage(contact, arrivedAt, "them", messageText);

    const cooldownMs = getCooldownMs(contact);
    const timeoutId  = setTimeout(() => {
      checkAndDraft(key).catch(err => log(`checkAndDraft error: ${err.message}`));
    }, DRAFT_DELAY_MS);
    pendingMessages.set(key, {
      contact, contactName, messageText, sanitizedText: preflight.context.sanitizedText,
      chatGuid: chatGuid || key, chatId, arrivedAt, timeoutId,
      contextMessages: preflight.context.messages, autoSendMs: cooldownMs,
    });
    log(`Draft queued for ${contactName} — fires in ${DRAFT_DELAY_MS / 1000}s (approval window: ${Math.round(cooldownMs / 1000)}s)`);

    return {
      ok: true, action: "draft_scheduled",
      contactName, chatGuid: key,
      draftFiresAt: new Date(arrivedAt + DRAFT_DELAY_MS).toISOString(),
      approvalExpiresAt: new Date(arrivedAt + DRAFT_DELAY_MS + cooldownMs).toISOString(),
    };
  } catch (err) {
    log(`Inbound error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  LEARNING PIPELINE  (Phase 1)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * True when the chat guid or the message marks a group chat. Direct chats use ";-;",
 * groups ";+;". imsg sets is_group (normalized to isGroup), which is what the Gateway
 * gates on. The participants-count rule is kept for legacy shapes only: imsg payloads
 * carry their participant list as participantHandles, so it does not apply to them.
 */
function isGroupChatGuid(chatGuid, eventData = {}) {
  if (chatGuid && chatGuid.includes(";+;")) return true;
  if (eventData.isGroup === true) return true;
  if (Array.isArray(eventData.participants) && eventData.participants.length > 1) return true;
  if (Array.isArray(eventData.chats)) {
    if (eventData.chats.some(c => (c.guid || c.chatGuid || "").includes(";+;"))) return true;
    if (eventData.chats.some(c => Array.isArray(c.participants) && c.participants.length > 1)) return true;
  }
  if (eventData.groupName || eventData.group_name) return true;
  return false;
}

function findChatsForPhone(phone, allChats) {
  const n    = normalizePhone(phone);
  const hits = [];

  for (const chat of allChats) {
    let matched = false;
    if (Array.isArray(chat.participants)) {
      for (const p of chat.participants) {
        const addr = typeof p === "string" ? p : (p.address || p.handle || p.id || "");
        if (normalizePhone(addr) === n) { matched = true; break; }
      }
    }
    // imsg chats.list carries the handle as "identifier"; BlueBubbles used "chatIdentifier".
    if (!matched && normalizePhone(chat.identifier || chat.chatIdentifier || "") === n) matched = true;
    if (!matched && typeof chat.guid === "string" && chat.guid.includes(`;-;+${n.slice(-10)}`)) matched = true;
    if (matched) hits.push(chat);
  }

  // Score: iMessage;-; > any;-; (macOS 14+ guids) > SMS;-;/RCS;-; > iMessageLite;-; > group > other
  const score = (c) => {
    const g = c.guid || "";
    const is1on1 = (c.participants || []).length <= 1;
    if (g.startsWith("iMessage;-;"))     return is1on1 ? 0 : 4;
    if (g.startsWith("any;-;"))          return is1on1 ? 1 : 4;
    if (g.startsWith("SMS;-;") || g.startsWith("RCS;-;")) return is1on1 ? 2 : 5;
    if (g.startsWith("iMessageLite;-;")) return is1on1 ? 3 : 6;
    if (g.includes(";+;"))               return 7;
    return 8;
  };
  hits.sort((a, b) => score(a) - score(b));
  return hits;
}

/**
 * A learn generation can fail in two ways, and only one of them is obvious.
 *
 * The obvious one is saying nothing, which the callers already reject. The dangerous one
 * is being cut off partway: a half-written voice profile still reads like a voice
 * profile, so it passes an emptiness check, gets stamped with today's date, and Ghost
 * then speaks as Klein out of a fragment. That is the same defect class as the stub this
 * session removed, arriving through a different door.
 *
 * Two independent signals, because neither is sufficient alone:
 *   - finish_reason === "length" is the provider saying it ran out of room. Direct, but
 *     not every provider sets it.
 *   - the `##` section count is our own oracle, derived from what the prompt asked for.
 *     It catches a model that stopped early of its own accord, and it does not care
 *     whether the API bothered to tell us.
 *
 * Returns the text so callers can use it as an expression.
 */
/**
 * Count the section headings in a generated document.
 *
 * The prompts ask for `## Heading`, and that is what the model usually returns — but
 * "usually" is not a contract, and rejecting a complete document because it used a
 * different heading style would be a false alarm that stops the nightly run for no
 * reason. Accept any markdown heading level, and also a bolded line used as a heading,
 * which is the common alternative. All that matters for the truncation check is that
 * headings are counted consistently, not that they use one exact syntax.
 */
function countSections(text) {
  const headings = text.match(/^\s{0,3}#{1,4}\s+\S/gm) || [];
  if (headings.length) return headings.length;
  return (text.match(/^\s{0,3}\*\*[^*\n]+\*\*:?\s*$/gm) || []).length;
}

function assertGeneratedWhole(result, { label, sections }) {
  if (result?.finishReason === "length") {
    throw new Error(
      `${label} was truncated at the ${LEARN_MAX_TOKENS}-token limit ` +
      `(finish_reason=length) — refusing to write a partial document`,
    );
  }
  const found = countSections(result.text);
  if (found < sections) {
    // Include a preview: "incomplete" alone cannot distinguish a truncated document
    // from one the model chose to format differently, and those need opposite fixes.
    throw new Error(
      `${label} is incomplete: ${found} of ${sections} requested sections ` +
      `— refusing to write a partial document. First 200 chars: ` +
      JSON.stringify(result.text.slice(0, 200)),
    );
  }
  return result.text;
}

function isFromKlein(m) {
  // imsg (normalized) and BlueBubbles HTTP use isFromMe:true; the retired MCP used from:"me"
  if (!m || typeof m !== "object") return false;
  return m.isFromMe === true || m.from === "me";
}

function analyzeKleinMessages(messages) {
  const mine = messages.filter(m => isFromKlein(m) && m.text?.trim());
  if (!mine.length) return null;
  const avgLen = Math.round(mine.reduce((s, m) => s + m.text.trim().length, 0) / mine.length);
  const freq   = {};
  for (const m of mine) {
    for (const w of m.text.toLowerCase().split(/\s+/)) {
      if (w.length > 2 && /[a-z]/.test(w)) freq[w] = (freq[w] || 0) + 1;
    }
  }
  const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([w]) => w).join(", ");
  const examples = mine.slice(-15).map(m => `"${m.text.trim().slice(0, 120)}"`).join("\n");
  return { avgLen, topWords, examples, sentCount: mine.length };
}

async function learnContact(contact, allChats) {
  log(`Learning: ${contact.alias} (${contact.phone})`);

  const candidateChats = findChatsForPhone(contact.phone, allChats);
  if (!candidateChats.length) { log(`No chat found for ${contact.alias}`); return null; }

  // Try each chat in ranked order until we get actual messages
  let messages = [];
  for (const chat of candidateChats) {
    log(`Trying chat ${chat.id} (${chat.guid})`);
    try {
      // Use higher limit for family_close contacts (high message frequency)
      const msgLimit = (contact.category === "family_close") ? 750 : 500;
      const msgs = Number.isInteger(chat.id) ? await imsgHistory(chat.id, msgLimit, 60000) : [];
      if (msgs.length > 0) { messages = msgs; break; }
      log(`  → 0 messages, trying next`);
    } catch (err) { log(`  → fetch error: ${err.message.slice(0,80)}`); }
  }

  if (!messages.length) { log(`No messages found for ${contact.alias} across ${candidateChats.length} chat(s)`); return null; }
  log(`Fetched ${messages.length} messages for ${contact.alias}`);

  const stats = analyzeKleinMessages(messages);
  if (!stats) { log(`No sent messages found for ${contact.alias}`); return null; }

  const recentConvo = messages
    .slice(0, 30)
    .filter(m => m.text?.trim())
    .reverse()
    .map(m => `${isFromKlein(m) ? "Klein" : contact.alias}: ${m.text.trim().slice(0, 150)}`)
    .join("\n");

  const prompt = `You are building a contact memory file for Ghost — Klein's AI auto-reply system.

Klein is a college student at Virginia Tech. ${contact.alias} is his ${contact.alias}.

STATS (Klein's messages to ${contact.alias}):
- Avg message length: ${stats.avgLen} chars
- Common words: ${stats.topWords}
- Total analyzed: ${stats.sentCount} sent messages

RECENT CONVERSATION (last 30 msgs):
${recentConvo || "(none)"}

Write a concise contact memory file in this format:

## Who They Are
[1-2 sentences: who they are to Klein, relationship type]

## Typical Topics
[3-5 bullets of what they usually discuss]

## Klein's Tone With Them
[energy level, formality, how he talks to this specific person]

## Running Threads
[any recurring jokes, plans, topics, or in-jokes]

## Sample Klein Messages
${stats.examples}

## Reply Guidelines
[2-3 specific instructions for Ghost when drafting to this person]

Keep it short and practical.`;

  log(`Generating contact summary for ${contact.alias}...`);
  // Runs on the local Spark box (see LEARN_MODEL).
  const result = await trySparkVllm(LEARN_MODEL, "", prompt, LEARN_TIMEOUT_MS, LEARN_MAX_TOKENS);
  const summary = result?.text || null;
  // D6/O-2: this used to substitute a stats-only stub and write it under a fresh date,
  // which is indistinguishable from real analysis at a glance — six nights of fakes went
  // unnoticed because of it. The helper collapses every failure to null, so the caller
  // cannot tell "model retired" from "nothing to say"; treat null as fatal and write
  // nothing, leaving any previously-good file on disk intact.
  if (!summary) {
    throw new Error(
      `contact summary generation failed for ${contact.alias}: ${LEARN_MODEL} returned no output ` +
      `— refusing to write a stats-only stub (see ghost-learn.log for the provider error)`,
    );
  }
  assertGeneratedWhole(result, {
    label: `contact summary for ${contact.alias}`,
    sections: CONTACT_SUMMARY_SECTIONS,
  });

  const filename = `${contact.phone}-${contact.alias.toLowerCase().replace(/\s+/g, "-")}.md`;
  const filepath = path.join(CONTACTS_MEMORY_DIR, filename);
  fs.mkdirSync(CONTACTS_MEMORY_DIR, { recursive: true });
  writeFileSafe(filepath, `# Contact Memory: ${contact.alias}\n_Updated: ${new Date().toISOString().slice(0, 10)}_\n\n${summary}\n`);
  log(`Saved: ${filepath}`);
  return summary;
}

async function buildVoiceProfile(summaries) {
  const combined = Object.entries(summaries)
    .map(([name, s]) => `### ${name}\n${s}`)
    .join("\n\n---\n\n");

  // D6/O-2: with no summaries the prompt degraded to "(no summaries yet)" and the model
  // was asked to describe a person it had been shown nothing about. Whatever came back
  // was invention, written to disk as fact — and Ghost drafts AS Klein from this file.
  // An empty corpus is not a degraded input, it is the absence of the input.
  if (!combined) {
    throw new Error(
      "voice profile generation skipped: no contact summaries were produced " +
      "— refusing to synthesise Klein's voice from an empty corpus",
    );
  }

  const prompt = `You are writing a voice profile for Ghost — Klein's AI auto-reply system.

Klein is a college student at VT. Here are cross-contact summaries of his texting style:

${combined}

Write a universal voice profile capturing what's consistent ACROSS all relationships:

## Core Typography
[capitalization, punctuation, abbreviation habits]

## Universal Vocabulary
[words and phrases Klein uses with everyone]

## Response Length
[typical length by context: quick check-in vs. making plans vs. emotional topic]

## What Klein Knows / Talks About
[his areas, interests, topics he brings up]

## How He Deflects
[how he avoids topics without being rude]

## Current Life Context
[VT student, semester, anything that affects his availability / mindset]

## What Immediately Sounds Like Klein
[5 things that would immediately tag a message as Klein]

Keep it practical — Ghost reads this before every draft.`;

  log("Building voice profile...");
  const result = await trySparkVllm(LEARN_MODEL, "", prompt, LEARN_TIMEOUT_MS, LEARN_MAX_TOKENS);
  const profile = result?.text || null;
  // D6/O-2: the fallback here was a two-line hardcoded literal, written under today's
  // date every night from 2026-08-06 on. Ghost reads this file before every draft and
  // speaks as Klein, so a stub is not a degraded profile — it is a fabricated identity.
  // Fail and leave the last real profile (or nothing) in place.
  if (!profile) {
    throw new Error(
      `voice profile generation failed: ${LEARN_MODEL} returned no output ` +
      `— refusing to write a hardcoded stub (see ghost-learn.log for the provider error)`,
    );
  }
  // A profile cut off at the token ceiling is worse than none: it looks generated, so
  // nothing downstream would question it.
  assertGeneratedWhole(result, { label: "voice profile", sections: VOICE_PROFILE_SECTIONS });

  writeFileSafe(VOICE_PROFILE_FILE, `# Klein Voice Profile\n_Updated: ${new Date().toISOString().slice(0, 10)}_\n\n${profile}\n`);
  log(`Voice profile saved: ${VOICE_PROFILE_FILE}`);
}

async function cmdLearn(args) {
  const targetPhone = args.includes("--contact") ? args[args.indexOf("--contact") + 1] : null;
  log("ghost learn starting...");
  fs.mkdirSync(CONTACTS_MEMORY_DIR, { recursive: true });

  log("Fetching chats from Messages via imsg rpc...");
  let allChats = [];
  try {
    allChats = await imsgChats(5000);
    log(`Got ${allChats.length} chats`);
  } catch (err) {
    console.error(`Failed to fetch chats: ${err.message}`);
    console.error("imsg on KleinBookPro needs Full Disk Access for the SSH context (owner step 1 in 128-25-GHOST.md).");
    process.exit(1);
  }

  const allowlist = loadAllowlist();
  const contacts  = targetPhone
    ? allowlist.filter(c => normalizePhone(c.phone) === normalizePhone(targetPhone))
    : allowlist;

  if (!contacts.length) {
    console.error(`No contacts found${targetPhone ? ` for ${targetPhone}` : ""}`);
    process.exit(1);
  }

  log(`Processing ${contacts.length} contact(s)...`);
  const summaries = {};
  // D6/O-2: failures are collected rather than thrown immediately so one dead contact
  // does not abort the sweep — but the run must still exit nonzero, because the old
  // behaviour (stub + "✅ complete" + exit 0) is exactly what hid six days of fakes.
  const failures = [];

  for (const c of contacts) {
    try {
      const s = await learnContact(c, allChats);
      if (s) summaries[c.alias] = s;
    } catch (err) {
      log(`FAILED: ${err.message}`);
      failures.push(`${c.alias}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1500)); // small breathe between contacts
  }

  if (!targetPhone || args.includes("--voice-profile")) {
    try {
      await buildVoiceProfile(summaries);
    } catch (err) {
      log(`FAILED: ${err.message}`);
      failures.push(`voice profile: ${err.message}`);
    }
  }

  const done = Object.keys(summaries).length;

  if (failures.length) {
    console.error(`\n❌ ghost learn FAILED: ${done}/${contacts.length} contacts produced real analysis, ${failures.length} step(s) failed`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error("\nNothing was written for the failed steps — existing files were left untouched.");
    throw new Error(`learn failed: ${failures.length} step(s) could not be generated`);
  }

  console.log(`\n✅ ghost learn complete: ${done}/${contacts.length} contacts processed`);
  if (done > 0) {
    console.log(`Contact memories: ${CONTACTS_MEMORY_DIR}`);
    console.log(`Voice profile:    ${VOICE_PROFILE_FILE}`);
    console.log("\nGhost will use this context for all future drafts.");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 5: PASSIVE NIGHTLY LEARNING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ghost schedule
 * Outputs the cron line to add for nightly learning.
 * Does NOT write the cron itself — Klein approves cron changes.
 */
function cmdSchedule() {
  const ghostBin = path.resolve(__filename);
  const logFile  = path.join(HOME, ".openclaw", "logs", "ghost-learn.log");
  const cronLine = `0 3 * * * /usr/bin/node ${ghostBin} learn --all --voice-profile >> ${logFile} 2>&1`;

  console.log(`\n📅 Phase 5 — Nightly Learning Cron`);
  console.log(`─────────────────────────────────────────────────────────`);
  console.log(`Runs: daily at 03:00 (learns from last 200 msgs per contact)`);
  console.log(`Log:  ${logFile}\n`);
  console.log(`Add this line to your crontab (crontab -e):\n`);
  console.log(`  ${cronLine}\n`);
  console.log(`Or ask Klein to run: crontab -e`);
  console.log(`─────────────────────────────────────────────────────────\n`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  STATUS
// ═══════════════════════════════════════════════════════════════════════════

async function cmdStatus() {
  const paused    = isPaused();
  const pauseData = paused ? loadJson(PAUSE_FILE, {}) : null;
  const pending   = loadPendingDrafts();

  let serverOk = false;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
    serverOk = r.ok;
  } catch {}

  let contacts = [];
  try { contacts = fs.readdirSync(CONTACTS_MEMORY_DIR).filter(f => f.endsWith(".md")); } catch {}
  const voiceOk = fs.existsSync(VOICE_PROFILE_FILE);

  console.log(`\n🔮 Ghost v3 Status`);
  console.log(`──────────────────────────────────`);
  console.log(`Server:        ${serverOk ? "✅ running" : "❌ down"} (port ${PORT})`);
  console.log(`Paused:        ${paused ? `⏸  YES${pauseData?.pauseUntil ? ` until ${pauseData.pauseUntil}` : ""}` : "▶️  no"}`);
  const sendToggle = ghostSendToggleState();
  console.log(`Send toggle:   ${sendToggle.enabled ? `🟢 ENABLED (${sendToggle.source})` : `🔴 DISABLED (${sendToggle.reason}) — drafts expire unsent`}`);
  console.log(`Pending:       ${pending.length} draft(s) awaiting action`);
  console.log(`Voice profile: ${voiceOk ? "✅" : "❌ missing  →  run: ghost learn"}`);
  console.log(`Contacts:      ${contacts.length}/7`);
  for (const f of contacts) console.log(`  · ${f}`);
  if (!contacts.length) console.log(`  (none — run: ghost learn)`);
  console.log();
}

// ═══════════════════════════════════════════════════════════════════════════
//  PAUSE / RESUME
// ═══════════════════════════════════════════════════════════════════════════

function cmdPause(args) {
  const hi = args.indexOf("--hours");
  const ui = args.indexOf("--until");
  let until = null;
  if      (hi !== -1 && args[hi + 1]) until = new Date(Date.now() + parseFloat(args[hi + 1]) * 3600000).toISOString();
  else if (ui !== -1 && args[ui + 1]) until = new Date(args[ui + 1]).toISOString();
  const data = { paused: true };
  if (until) data.pauseUntil = until;
  saveJson(PAUSE_FILE, data);

  // Hard stop pending sends while paused to prevent any delayed auto-send race.
  pendingMessages.clear();
  savePendingDrafts([]);

  console.log(`✅ Ghost paused${until ? ` until ${until}` : " indefinitely"}. Cleared pending drafts.`);
}

function cmdResume() {
  try { fs.unlinkSync(PAUSE_FILE); console.log("✅ Ghost resumed."); }
  catch { console.log("Ghost was not paused."); }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SERVE
// ═══════════════════════════════════════════════════════════════════════════



function cmdServe() {
  expireOrphanedDraftsOnStartup();
  const server = createServer();
  server.listen(PORT, BIND_HOST, () => {
    log(`Ghost v3 listening on ${BIND_HOST}:${PORT} (status only)`);
    log(`  Health  : http://127.0.0.1:${PORT}/health`);
    log(`  Pending : http://127.0.0.1:${PORT}/pending`);
    log(`  Inbound : imsg rpc via ${imsg.IMSG_CLI}`);
    log(`  Send    : ${imsg.OPENCLAW_BIN} message send --channel imessage (after native approval)`);
  });

  imsgWatch = imsg.startImsgWatch({ onMessage: handleInboundMessage, log, cursorFile: IMSG_CURSOR_FILE });

  process.on("SIGTERM", () => {
    log("SIGTERM — shutting down...");
    if (imsgWatch) imsgWatch.stop();
    for (const [key, entry] of pendingMessages) {
      clearTimeout(entry.timeoutId);
      log(`  Cancelled pending: ${entry.contactName} (${key})`);
    }
    pendingMessages.clear();
    server.close(() => { log("Server closed."); process.exit(0); });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  RETRIGGER CLI
// ═══════════════════════════════════════════════════════════════════════════

async function cmdRetrigger(args) {
  const scan = args.includes("--scan");

  if (scan) {
    console.log("Scanning Messages chats for unknown contacts...");
    const chats = await imsgChats(1000);
    console.log(`Scanned ${chats.length} chats`);
    let found = 0;
    for (const chat of chats) {
      if (typeof chat.guid !== "string" || !chat.guid.includes(";-;")) continue;
      const norm = normalizePhone(chat.identifier || chat.guid.split(";").pop());
      if (!norm || norm.length < 7 || norm === OWNER_PHONE_NORMALIZED) continue;
      if (isAllowed(norm) || isDenied(norm) || pendingUnknownAlerts.has(norm)) continue;
      let lastMsg = "(no recent message)";
      const msgs = await fetchRecentMessages(chat.id, 1);
      if (msgs.length && msgs[0].text) lastMsg = msgs[0].text;
      console.log(`  Asking about unknown: +${norm}`);
      postUnknownAlert(norm, lastMsg, `+${norm}`, { source: "unknown" })
        .then(r => console.log(`  +${norm}: ${r.action}`))
        .catch(err => console.error(`  +${norm}: ${err.message}`));
      found++;
    }
    console.log(`Asked about ${found} unknown contact(s); waiting for the approval cards...`);
    while (pendingUnknownAlerts.size) await new Promise(r => setTimeout(r, 1000));
    return;
  }

  const phone = args.find(a => a.startsWith("+") || /^\d{10,}$/.test(a));
  if (!phone) {
    console.error("Usage: ghost retrigger <+phone>  OR  ghost retrigger --scan");
    process.exit(1);
  }

  const norm = normalizePhone(phone);
  if (isAllowed(norm)) {
    console.log(`+${norm} is already in the allowlist — no request needed.`);
    return;
  }
  if (isDenied(norm)) {
    console.log(`+${norm} is in the denylist — remove it from data/ghost-denylist.json first to re-evaluate.`);
    return;
  }

  let lastMsg = "(no recent message)";
  try {
    const chat = findChatsForPhone(`+${norm}`, await imsgChats(1000))[0];
    const msgs = chat ? await fetchRecentMessages(chat.id, 1) : [];
    if (msgs.length && msgs[0].text) lastMsg = msgs[0].text;
  } catch {}

  console.log(`Asking the owner about +${norm} (approval card in #ghost-openclaw)...`);
  const r = await postUnknownAlert(`+${norm}`, lastMsg, `+${norm}`, { source: "unknown" });
  console.log(`Result: ${r.action}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

// Only run CLI when executed directly — not when required as a module (e.g. by tests)
if (require.main === module) {
const [,, cmd = "serve", ...cmdArgs] = process.argv;

switch (cmd) {
  case "serve":
    cmdServe();
    break;
  case "learn":
    cmdLearn(cmdArgs)
      .then(() => process.exit(0))
      .catch(err => { console.error(err.message); process.exit(1); });
    break;
  case "status":
    cmdStatus().then(() => process.exit(0));
    break;
  case "pause":
    cmdPause(cmdArgs);
    break;
  case "resume":
    cmdResume();
    break;
  case "schedule":
    cmdSchedule();
    break;
  case "retrigger":
    cmdRetrigger(cmdArgs)
      .then(() => process.exit(0))
      .catch(err => { console.error(err.message); process.exit(1); });
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.log("Usage: ghost [serve|learn|status|pause|resume|schedule|retrigger]");
    console.log("");
    console.log("  serve                  watch iMessage (imsg rpc) + local status server");
    console.log("  learn [--all]          build contact memories + voice profile   (Phase 1)");
    console.log("  learn --contact <num>  learn one contact");
    console.log("  status                 show server/memory/draft state");
    console.log("  pause [--hours N]      pause ghost");
    console.log("  resume                 resume ghost");
    console.log("  schedule               print nightly learn cron line            (Phase 5)");
    console.log("  retrigger <+phone>     ask the owner about an unknown number (native approval card)");
    console.log("  retrigger --scan       scan Messages chats and ask about every unknown number");
    process.exit(1);
}
} // end require.main === module guard

// ── Test exports (only when required as a module, not run directly) ──────────
if (require.main !== module) {
  module.exports = {
    normalizePhone,
    isFromKlein,
    requiresReply,
    isQuietHours,
    loadAllowlist,
    loadContactsMap,
    isDenied,
    isLikelySpam,
    isAllowed,
    isGroupChatGuid,
    findChatsForPhone,
    // New exports for testing
    scanForInjection,
    passesContentSafety,
    getCooldownMs,
    randomCooldown,
    onGhostSend,
    onContactMessage,
    loadConvState,
    saveConvState,
    NEVER_SAY,
    INJECTION_PATTERNS,
    COOLDOWN_STRANGER_MIN_MS,
    COOLDOWN_STRANGER_MAX_MS,
    COOLDOWN_ACTIVE_MIN_MS,
    COOLDOWN_ACTIVE_MAX_MS,
    ACTIVE_EXCHANGE_THRESHOLD,
    ACTIVE_TIMEOUT_MS,
    CATEGORY_AUTO_SEND_MS,
    // Bug-fix exports
    normalizeTs,
    // Integration test exports
    createServer,
    runPreflight,
    logFeedback,
    pendingUnknownAlerts,
    pendingMessages,
    loadPendingDrafts,
    savePendingDrafts,
    checkAndDraft,
    cmdServe,
    DATA_DIR,
    GHOST_DIR,
    GHOST_CHANNEL,
    DRAFT_DELAY_MS,
    postCannotAnswerAlert,
    buildSystemPrompt,
    postDraftToDiscord,
    indexMessage,
    embedText,
    // New exports for fix validation tests
    sanitizeMessageText,
    sanitizeForModel,
    cancelledDraftIds,
    cancelledDraftTtl,
    kleinRepliedRecentlyChats,
    unknownAlertCounts,
    // Rate-limit + backoff exports
    outboundRateGate,
    getRateBackoff,
    recordRateLimitHit,
    clearRateBackoff,
    hasInternalDriftMarkers,
    // F9 embed builders (structural tests)
    EMBED_COLORS,
    buildNoticeEmbed,
    buildInjectionEmbed,
    buildAutoDenyEmbed,
    buildTransactionalEmbed,
    buildExpiryEmbed,
    buildCancelEmbed,
    buildUnknownAlertEmbed,
    OUTBOUND_BACKOFF_FILE,
    OUTBOUND_RATE_FILE,
    BACKOFF_BASE_MS,
    BACKOFF_MAX_LEVEL,
    sendLocks,
    // Bind-host export (90-01: loopback confinement support)
    BIND_HOST,

    // 90-03: fail-closed send toggle + style allowlist + expiry-cancel exports
    sendIMessage, executeSend, ghostSendToggleState, styleAllowlistViolation,
    SEND_TOGGLE_FILE, AUTO_SEND_WINDOW_MS,
    // D6/O-2: learn must fail loudly rather than write convincing stubs
    learnContact, buildVoiceProfile, cmdLearn, LEARN_MODEL,
    VOICE_PROFILE_FILE, CONTACTS_MEMORY_DIR,
    // D6/O-2 cycle 2: the token budget is per-call, so both helpers are exported to pin
    // that the draft budgets did NOT move when learn's did.
    tryOpenRouter, trySparkVllm, LEARN_MAX_TOKENS,
    // Audit-fix exports (PR #2, 2026-10-26)
    addToAllowlist,
    addToDenylist,
    dmPhoneFromChatGuid,
    discordPost,
    isAuthorizedRequest,
    // NAT-25: native iMessage transport (imsg rpc, plugin approvals, native send)
    setTransport,
    handleInboundMessage,
    awaitDraftApproval,
    resolveDraftDecision,
    resolveUnknownContactDecision,
    postUnknownAlert,
    expireOrphanedDraftsOnStartup,
    fetchRecentMessages,
    kleinRepliedSince,
    IMSG_CURSOR_FILE,
    MAX_UNKNOWN_ALERTS,
    UNKNOWN_APPROVAL_MS,
  };
}
