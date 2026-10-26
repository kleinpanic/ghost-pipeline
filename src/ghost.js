#!/usr/bin/env node
/**
 * ghost.js — Unified Ghost iMessage Pipeline v3
 *
 * Usage:
 *   ghost serve                       run HTTP server + embedded reaction check loop
 *   ghost react                       one-shot reaction check (manual trigger)
 *   ghost learn [--all]               build/update contact memories + voice profile
 *   ghost learn --contact <phone>     process one contact only
 *   ghost status                      show current state
 *   ghost pause [--hours N]           pause ghost (optional duration)
 *   ghost pause [--until ISO]         pause until timestamp
 *   ghost resume                      resume ghost
 *
 * Replaces:
 *   ~/.openclaw/hooks/bluebubbles-webhook.js
 *   ~/.openclaw/hooks/ghost-reaction-check.sh  (now embedded in `serve`)
 *   ~/.openclaw/workspace-ghost/scripts/check-allowlist.sh
 *   ~/.openclaw/workspace-ghost/scripts/rate-limiter.sh
 *   ~/.openclaw/workspace-ghost/scripts/sanitize-input.sh
 */

"use strict";

const http   = require("http");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { spawnSync, spawn } = require("child_process");

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
const BUTTON_ACTIONS_FILE   = path.join(DATA_DIR, "ghost-button-actions.json");
// Separate registry for OC-managed button shortIds (object format, keyed by shortId)
const BUTTON_REGISTRY_FILE  = path.join(DATA_DIR, "ghost-button-registry.json");
const PAUSE_FILE          = path.join(DATA_DIR, "ghost-paused.json");
const SOUL_FILE           = path.join(GHOST_DIR, "SOUL.md");
const VOICE_PROFILE_FILE  = path.join(GHOST_DIR, "memory", "voice-profile.md");
const CONTACTS_MEMORY_DIR = path.join(GHOST_DIR, "memory", "contacts");
const LOCK_FILE           = path.join(DATA_DIR, "ghost-reaction-check.lock");
const SPAM_LOG_FILE       = path.join(DATA_DIR, "ghost-spam-log.json");
const SPAM_RATELIMIT_FILE = path.join(DATA_DIR, "ghost-spam-ratelimit.json");
const FEEDBACK_FILE       = path.join(DATA_DIR, "ghost-feedback.json");
const OUTBOUND_RATE_FILE  = path.join(DATA_DIR, "ghost-outbound-rate.json");
const OUTBOUND_BACKOFF_FILE = path.join(DATA_DIR, "ghost-outbound-backoff.json");
const EVENT_DEDUP_FILE    = path.join(DATA_DIR, "ghost-event-dedup.json");

// Per-contact send lock — prevents concurrent sends to the same contact
const sendLocks = new Map();

// Embeddings + memories DB
const GHOST_MEMORIES_DB   = path.join(DATA_DIR, "ghost-memories.db");
const GHOST_CONV_STATE_FILE = path.join(DATA_DIR, "ghost-conv-state.json");

// ── In-memory race-condition guards ─────────────────────────────────────────
// Prevents /action cancel from racing with doReactionCheck auto-send
const cancelledDraftIds = new Set();
const cancelledDraftTtl = new Map(); // draftId → expiryMs

// Prevents outgoing-message webhook from racing with doReactionCheck auto-send
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
const BB_PASSWORD        = readSecret(path.join(HOME, ".config", "bluebubbles", "password"));
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
// Interface the webhook server binds to. 0.0.0.0 because BlueBubbles posts from another host.
const BIND_HOST = env("GHOST_BIND_HOST", "0.0.0.0");
// Shared secret for the HTTP API. When set, the BlueBubbles webhook must present it, and
// non-loopback callers may use the control endpoints with it. Sent as
// "Authorization: Bearer <t>", "X-Ghost-Token: <t>", or "?token=<t>" (for the BB webhook URL).
const GHOST_API_TOKEN = env("GHOST_API_TOKEN");
const MAX_BODY_BYTES  = 1024 * 1024;
const BB_HOST = env("BB_HOST", "127.0.0.1");
const BB_PORT = parseInt(env("BB_PORT", "1234"));

// Discord
const GHOST_CHANNEL = env("GHOST_CHANNEL_ID");

// Identity
const OWNER_PHONE_NORMALIZED = env("OWNER_PHONE");
const KLEIN_DISCORD_USER_ID  = env("KLEIN_DISCORD_USER_ID");

// Timing
const DRAFT_DELAY_MS          = 30 * 1000;        // generate draft 30s after message (debounce)
const AUTO_SEND_WINDOW_MS     = 5  * 60 * 1000;  // auto-send 5 min after draft posts (if no Cancel)

const REACT_CHECK_INTERVAL_MS = 60 * 1000;       // reaction check every 60s
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

// ── Phase 2: Spark vllm (local, fastest, strongest)
const SPARK_BASE_URL = env("SPARK_BASE_URL", "http://127.0.0.1:18080/v1");
const SPARK_API_KEY  = readSecret(path.join(HOME, ".openclaw", ".spark-key")) ||
                       env("SPARK_API_KEY");
const SPARK_MODEL_FAST   = "openai/gpt-oss-20b";
const SPARK_MODEL_STRONG = "openai/gpt-oss-120b";

// ── Phase 4: OpenClaw Ghost Agent  (uses full model chain + workspace context)
const OC_GATEWAY_TOKEN = readSecret(path.join(HOME, ".openclaw", ".gateway-token")) ||
                         env("OC_GATEWAY_TOKEN");

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
function loadButtonRegistry() {
  const d = loadJson(BUTTON_REGISTRY_FILE, {});
  return (d && typeof d === "object" && !Array.isArray(d)) ? d : {};
}
function saveButtonRegistry(registry) {
  // Trim entries older than 24h on every write
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const trimmed = {};
  for (const [k, v] of Object.entries(registry)) {
    if (!v.postedAt || new Date(v.postedAt).getTime() > cutoff) trimmed[k] = v;
  }
  saveJson(BUTTON_REGISTRY_FILE, trimmed);
}

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

function extractLastJson(text) {
  let depth = 0, end = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if      (text[i] === "}") { if (depth === 0) end = i; depth++; }
    else if (text[i] === "{") {
      depth--;
      if (depth === 0 && end !== -1) {
        try { return JSON.parse(text.slice(i, end + 1)); } catch {}
        end = -1;
      }
    }
  }
  return null;
}

function parseIncomingEvent(body, contentType) {
  const trimmed = (typeof body === "string" ? body : "").trim();
  if (!trimmed) throw new Error("empty webhook payload");

  // Direct JSON
  const direct = tryParseJson(trimmed);
  if (direct && typeof direct === "object") {
    if (direct.data && typeof direct.data === "object") return direct;
    if (direct.event && typeof direct.event === "object") return direct.event;
  }

  // Form-encoded wrapper
  const isForm = (contentType || "").toLowerCase().includes("application/x-www-form-urlencoded");
  if (isForm || trimmed.includes("=")) {
    const params = new URLSearchParams(trimmed);
    for (const key of ["payload", "event", "data", "message"]) {
      const val = tryParseJson(params.get(key));
      if (val && typeof val === "object") {
        if (val.data  && typeof val.data  === "object") return val;
        if (val.event && typeof val.event === "object") return val.event;
      }
    }
  }

  // openclaw JSON buried in mixed stdout
  const buried = extractLastJson(trimmed);
  if (buried && typeof buried === "object") {
    if (buried.data  && typeof buried.data  === "object") return buried;
    if (buried.event && typeof buried.event === "object") return buried.event;
  }

  throw new SyntaxError("Unable to parse BlueBubbles payload as JSON event");
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
  return String(value ?? "")
    .replace(/<!--|-->|CONTACT_ALLOWLIST_(START|END)/gi, "")
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

function bbRequest(endpoint, params = {}) {
  return new Promise((resolve) => {
    const qs      = new URLSearchParams({ password: BB_PASSWORD, ...params }).toString();
    const options = { host: BB_HOST, port: BB_PORT, path: `/api/v1/${endpoint}?${qs}`, method: "GET" };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on("error", err => { log(`BB API error (${endpoint}): ${err.message}`); resolve(null); });
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function bbPost(endpoint, body = {}) {
  return new Promise((resolve) => {
    const qs      = new URLSearchParams({ password: BB_PASSWORD }).toString();
    const payload = JSON.stringify(body);
    const options = {
      host: BB_HOST, port: BB_PORT,
      path: `/api/v1/${endpoint}?${qs}`, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on("error", err => { log(`BB POST error (${endpoint}): ${err.message}`); resolve(null); });
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

async function fetchRecentMessages(chatGuid, limit = 20) {
  // Primary path: non-blocking MCP call (mcporterCallAsync — does NOT block event loop)
  try {
    const data = await mcporterCallAsync("bb_get_chat_messages", { chat_guid: chatGuid, limit, sort: "DESC" });
    const msgs = extractBBList(data);
    if (msgs.length > 0 || data?.status === 200) return msgs;
  } catch (err) {
    log(`fetchRecentMessages MCP path failed (${err.message?.slice(0, 60)}); falling back to direct BB`);
  }
  // Fallback: direct BB HTTP (works even if MCP/SSH tunnel is down)
  const data = await bbRequest(`chat/${encodeURIComponent(chatGuid)}/message`, { limit, sort: "DESC" });
  return Array.isArray(data?.data) ? data.data : [];
}

async function resolveChatGuid(phone) {
  // When webhook events omit chatGuid, resolve the real "iMessage;-;+E164" guid
  // via direct BB HTTP (fast, no MCP tunnel dependency).
  // Paginates ALL chats in batches of 300 — with 1595+ chats the target thread
  // is often not in the first page, causing false "could not resolve" failures.
  try {
    const normalized = normalizePhone(phone);
    let allChats = [];
    let offset   = 0;
    while (true) {
      const data  = await bbPost("chat/query", { limit: 300, offset, sort: "lastmessage", withLastMessage: false });
      const batch = extractBBList(data);
      if (!batch.length) break;
      allChats.push(...batch);
      if (batch.length < 300) break;
      offset += 300;
    }
    const guid = findChatGuidForPhone(`+${normalized}`, allChats) ||
                 findChatGuidForPhone(normalized, allChats);
    // BUG-2 FIX: if the resolved guid is a group chat, do NOT proceed — require a direct 1:1 match.
    // Ghost must never send to an individual when the triggering message came from a group chat context.
    if (guid && guid.includes(";+;")) {
      log(`resolveChatGuid: resolved guid ${guid} is a group chat — rejecting (groupChatSender protection)`);
      return null;
    }
    if (guid) log(`Resolved chatGuid for +${normalized}: ${guid} (scanned ${allChats.length} chats)`);
    else log(`resolveChatGuid: no match for +${normalized} in ${allChats.length} chats`);
    return guid || null;
  } catch (err) {
    log(`resolveChatGuid failed for ${phone}: ${err.message?.slice(0, 60)}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MODEL GENERATION  (OR claude-haiku → OR gemini-flash → Spark fallback)
// ═══════════════════════════════════════════════════════════════════════════

/** Learn-pipeline tier: Gemini CLI one-shot prompt. Returns text or null. */
async function tryGeminiCli(prompt, { timeoutMs = 30000 } = {}) {
  try {
    const stdout = await spawnAsync("gemini", ["-p", prompt], { timeout: timeoutMs });
    const text   = stdout.trim();
    if (!text) return null;
    // Strip known preamble lines from Gemini CLI output
    const filtered = text.split("\n").filter(l => !l.match(/^(Using model:|Model:|\s*$)/));
    return filtered.join("\n").trim() || null;
  } catch (err) {
    log(`Gemini CLI unavailable: ${err.message.slice(0, 80)}`);
    return null;
  }
}

/** Try OpenRouter with a specific model. Returns { text, usage } or null. */
function tryOpenRouter(model, systemPrompt, userContent, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (!OPENROUTER_API_KEY) { resolve(null); return; }
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent  },
      ],
      max_tokens:  200,
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
            resolve({ text, usage });
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

/** Try Spark vllm (local DGX). model = SPARK_MODEL_FAST | SPARK_MODEL_STRONG */
function trySparkVllm(model, systemPrompt, userContent, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent  },
      ],
      max_tokens:  180,
      temperature: 0.72,
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
          if (text) { log(`Spark [${model.split("/").pop()}] draft ok`); resolve(text); }
          else { log(`Spark [${model.split("/").pop()}] empty`); resolve(null); }
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

/**
 * Run one Ghost agent turn via the OpenClaw CLI.
 * The ghost agent uses its full workspace (SOUL.md + memory + model chain).
 * Returns draft text or null.
 */
async function tryGhostAgent(contactName, contactPhone, messageText, historyLines) {
  // Format the message Ghost will receive — tell it exactly what to produce
  const msg = [
    `GHOST DRAFT REQUEST`,
    `Contact: ${contactName}`,
    `Their message: "${messageText}"`,
    historyLines ? `Recent conversation:\n${historyLines}` : "",
    ``,
    `Output ONLY the reply text Klein would send — no explanation, no quotes around it. Max 2 short texts.`,
  ].filter(Boolean).join("\n");

  try {
    const stdout = await spawnAsync("openclaw", [
      "agent",
      "--agent",   "ghost",
      "--message", msg,
      "--json",
    ], { timeout: 90000 });  // ghost agent can take 60-90s cold

    // openclaw --json output has mixed log lines; extract last valid JSON
    const data = extractLastJson(stdout) || tryParseJson(stdout.trim());
    // reply text lives in different keys depending on version
    const text = (
      data?.reply   ||
      data?.text    ||
      data?.content ||
      data?.message ||
      (Array.isArray(data?.messages) ? data.messages[data.messages.length - 1]?.content : null) ||
      ""
    ).trim();

    if (text && text.length > 0 && text.length < 600) {
      log(`Ghost agent draft ok: "${text.slice(0, 60)}"`);
      return text;
    }
    log(`Ghost agent: unusable response (len=${text.length})`);
    return null;
  } catch (err) {
    log(`Ghost agent failed: ${err.message.slice(0, 100)}`);
    return null;
  }
}

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
 * - Ghost agent session: must be active within last 30 min (via OC gateway sessions_list)
 * - OR models: skipped if OR_COOLDOWN_MAP has a future cooldownUntilMs entry
 * - Spark is intentionally excluded (style/persona task, not code/reasoning)
 */
async function probeAvailableModels() {
  const available = [];

  // 1. Ghost agent session — check via OC gateway sessions_list
  if (OC_GATEWAY_TOKEN) {
    try {
      const body = JSON.stringify({ tool: "sessions_list", args: {} });
      const sessionData = await new Promise((resolve) => {
        const req = https.request({
          hostname: "127.0.0.1",
          port:     OC_GATEWAY_PORT,
          path:     "/tools/invoke",
          method:   "POST",
          rejectUnauthorized: false,
          headers: {
            "Authorization":  `Bearer ${OC_GATEWAY_TOKEN}`,
            "Content-Type":   "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        }, (res) => {
          let data = "";
          res.on("data", c => { data += c; });
          res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.setTimeout(3000, () => { req.destroy(); resolve(null); });
        req.on("error", () => resolve(null));
        req.write(body);
        req.end();
      });

      // sessions_list response format: { ok, result: { content: [{ type:"text", text: JSON({sessions:[]}) }] } }
      let sessions = [];
      try {
        const textContent = sessionData?.result?.content?.[0]?.text;
        if (textContent) {
          sessions = JSON.parse(textContent).sessions || [];
        } else if (Array.isArray(sessionData?.result)) {
          sessions = sessionData.result;
        } else if (Array.isArray(sessionData)) {
          sessions = sessionData;
        }
      } catch { sessions = []; }

      const ghostSession = sessions.find(
        s => (s.key || s.sessionKey || s.id || "") === GHOST_AGENT_SESSION_KEY
      );

      if (ghostSession) {
        const updatedAt = ghostSession.updatedAt ? new Date(ghostSession.updatedAt).getTime() : 0;
        const ageMin    = (Date.now() - updatedAt) / 60000;
        if (ageMin <= 30) {
          available.push("ghost-agent");
          log(`probeAvailableModels: ghost-agent active (age ${ageMin.toFixed(1)}min)`);
        } else {
          log(`probeAvailableModels: ghost-agent stale (age ${ageMin.toFixed(1)}min > 30min)`);
        }
      } else {
        log("probeAvailableModels: ghost-agent session not found");
      }
    } catch (err) {
      log(`probeAvailableModels: ghost-agent probe failed (${(err.message || "").slice(0, 60)})`);
    }
  }

  // 2. OR models only — haiku first, then fallbacks.
  //    Spark is intentionally excluded: Ghost is a style/persona task, not a coding/reasoning task.
  const now = Date.now();
  for (const entry of GHOST_DRAFT_MODELS) {
    const coolUntil = OR_COOLDOWN_MAP.get(entry.id);
    if (!coolUntil || now > coolUntil) {
      available.push(entry.label);
    } else {
      log(`probeAvailableModels: ${entry.label} cooling (${Math.ceil((coolUntil - now) / 1000)}s remaining)`);
    }
  }

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

const GHOST_AGENT_SESSION_KEY = "agent:ghost:main";
const OC_GATEWAY_PORT         = 18789;  // loopback TLS, confirmed

// Authenticated OC gateway client — all /tools/invoke calls go through here.
// Adds request ID + timestamp headers for auditability; throws on auth failure.
async function ocGatewayInvoke(tool, args, timeoutMs = 25000) {
  if (!OC_GATEWAY_TOKEN) throw new Error("OC gateway token not configured");
  const requestId = crypto.randomBytes(8).toString("hex");
  const body = JSON.stringify({ tool, args });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname:           "127.0.0.1",
      port:               OC_GATEWAY_PORT,
      path:               "/tools/invoke",
      method:             "POST",
      rejectUnauthorized: false,   // self-signed local cert
      headers: {
        "Authorization":  `Bearer ${OC_GATEWAY_TOKEN}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-Request-ID":   requestId,
        "X-Timestamp":    Date.now().toString(),
      },
    }, (res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        res.resume();
        return reject(new Error(`OC gateway auth failure (${res.statusCode}) req=${requestId}`));
      }
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed?.error) return reject(new Error(`OC gateway error: ${JSON.stringify(parsed.error).slice(0, 120)} req=${requestId}`));
          resolve({ requestId, parsed });
        } catch (e) {
          reject(new Error(`OC gateway parse error: ${e.message} req=${requestId}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`OC gateway timeout req=${requestId}`)); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function tryGhostAgentSession(contactName, messageText, systemPrompt, userContent, timeoutMs = 25000) {
  if (!OC_GATEWAY_TOKEN) { log("Ghost agent: no gateway token — skipping"); return null; }

  const prompt = [
    `You are drafting a reply for Klein. Use his texting style from your SOUL.md.`,
    `Contact: ${contactName}`,
    systemPrompt ? `\nContext:\n${systemPrompt}` : "",
    `\n${userContent}`,
    `\nOutput ONLY the reply text — nothing else. Max 1-2 short texts.`,
  ].join("\n");

  try {
    const { requestId, parsed } = await ocGatewayInvoke("sessions_send", {
      sessionKey:     GHOST_AGENT_SESSION_KEY,
      message:        prompt,
      timeoutSeconds: Math.floor(timeoutMs / 1000) - 2,
    }, timeoutMs);

    const inner   = parsed?.result?.details ?? parsed?.result;
    const rawText = (typeof inner === "string" ? inner
      : inner?.reply ?? inner?.text ?? inner?.message ?? inner?.content?.[0]?.text ?? "");
    let text = rawText.trim();
    try { const j = JSON.parse(text); text = j.text ?? j.reply ?? j.message ?? text; } catch {}

    if (!text) {
      log(`Ghost agent session: empty response (req=${requestId})`);
      return null;
    }
    if (hasInternalDriftMarkers(text)) {
      log(`Ghost agent session: BLOCKED internal marker in response (req=${requestId})`);
      return null;
    }
    log(`Ghost agent session draft ok (req=${requestId}): "${text.slice(0, 40)}"`);
    return { text: text.trim(), model: "ghost-agent" };
  } catch (e) {
    log(`Ghost agent session error: ${e.message}`);
    return null;
  }
}

/**
 * Post a message via the OpenClaw gateway tools/invoke endpoint.
 * Used for posting draft buttons so OC registers the components (prevents 30-min expiry).
 * Returns the parsed JSON response or null on failure.
 */
function ocGatewayPost(tool, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!OC_GATEWAY_TOKEN) { resolve(null); return; }
    // Route component clicks to ghost agent session (not main agent)
    const body = JSON.stringify({ tool, args, sessionKey: GHOST_AGENT_SESSION_KEY });
    const req = https.request({
      hostname: "127.0.0.1",
      port:     OC_GATEWAY_PORT,
      path:     "/tools/invoke",
      method:   "POST",
      rejectUnauthorized: false,
      headers: {
        "Authorization":  `Bearer ${OC_GATEWAY_TOKEN}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

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

  // Helper: check content safety then return or log+skip
  const safeReturn = (text, model) => {
    if (!text) return null;
    const trimmed = text.trim();
    if (!passesContentSafety(trimmed, model)) {
      log(`Draft failed content safety [${model}] — trying next model`);
      return null;
    }
    return { text: trimmed, model };
  };

  for (const modelKey of available) {
    switch (modelKey) {
      case "ghost-agent": {
        // ghost-agent tier disabled — consistently times out (~14s); haiku with same SOUL context is equivalent and 15x faster
        // Re-enable when ghost agent session is tuned for low-latency draft responses
        log("Draft tier ghost-agent: skipped (disabled — use haiku)");
        break;
      }
      case "spark-fast": {
        log("Draft: Spark gpt-oss-20b...");
        const t = await trySparkVllm(SPARK_MODEL_FAST, systemPrompt, userContent);
        const r = safeReturn(t, "spark-20b");
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
        log("Draft: Spark gpt-oss-120b (last resort)...");
        const t = await trySparkVllm(SPARK_MODEL_STRONG, systemPrompt, userContent, 25000);
        const r = safeReturn(t, "spark-120b");
        if (r) return r;
        if (!t) invalidateSparkCache();
        break;
      }
    }
  }

  log("Draft: all probed models exhausted (or all failed content safety)");
  return { text: null, model: "safety-blocked" };
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

async function discordDelete(channelId, messageId) {
  try {
    await spawnAsync("curl", [
      "-s", "-X", "DELETE",
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      "--config", "-",
    ], { timeout: 8000, input: discordAuthCurlConfig() });
  } catch (err) {
    log(`Discord delete error: ${err.message}`);
  }
}

// In-memory map of unanswered unknown-contact alerts: phone → { messageId, postedAt, alertedAt, alertCount, phone, messageText, contactName, source, enrichment }
const pendingUnknownAlerts = new Map();

// ═══════════════════════════════════════════════════════════════════════════
//  PENDING DRAFTS
// ═══════════════════════════════════════════════════════════════════════════

function loadPendingDrafts() {
  const d = loadJson(PENDING_DRAFTS_FILE, []);
  return Array.isArray(d) ? d : [];
}
function savePendingDrafts(drafts) { saveJson(PENDING_DRAFTS_FILE, drafts); }

async function postDraftToDiscord(draftResult, meta) {
  const { chatGuid, contact, contactName, messageText, arrivedAt, contextMessages, autoSendMs } = meta;
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
  content += `\n**Context** (${ctxMsgs.length})\n`;
  for (const m of ctxMsgs) {
    const label = (m.isFromMe === true || m.from === "me") ? "You" : contactName;
    content += `> **${label}**: ${m.text.trim().slice(0, 120)}\n`;
  }

  const isSafetyBlocked = draftResult && draftResult.model === "safety-blocked";
  const hasUsableDraft  = draftResult && draftResult.text && !isSafetyBlocked;

  if (hasUsableDraft) {
    const cooldownMin = Math.round((autoSendMs || AUTO_SEND_WINDOW_MS) / 60000 * 10) / 10;
    const draftLines  = draftResult.text.split("\n").map(l => `> ${l}`).join("\n");
    // Show token usage + cost from OR response
    const usage = draftResult.usage;
    let usageStr = "";
    if (usage) {
      const pt = usage.prompt_tokens || 0;
      const ct = usage.completion_tokens || 0;
      const tt = usage.total_tokens || (pt + ct);
      // OR returns cost in USD as usage.cost (some models) or generation.cost
      const cost = typeof usage.cost === "number" ? usage.cost
        : typeof usage?.["x-ratelimit-cost"] === "number" ? usage["x-ratelimit-cost"] : null;
      const costStr = cost !== null ? ` · $${cost.toFixed(5)}` : "";
      usageStr = ` · ${tt}tok (↑${pt} ↓${ct})${costStr}`;
    }
    content += `\n**Draft** · _${draftResult.model}_${usageStr} · ${convMode}\n${draftLines}\n`;
    content += `\n⏱️ Auto-sends in ${cooldownMin} min · \`${draftId}\``;
  } else if (isSafetyBlocked) {
    content += `\n⚠️ All draft tiers failed content safety — reply manually.`;
  } else {
    content += `\n⚠️ Draft generation failed — reply manually.`;
  }

  // Hard cap at 1900 chars
  if (content.length > 1900) content = content.slice(0, 1897) + "…";

  let messageId = null;

  if (hasUsableDraft && OC_GATEWAY_TOKEN) {
    // BUG-1 FIX: post via OC gateway so component registration persists (no 30-min TTL).
    // discordPost() bypasses OC → buttons expire. OC gateway registers them as reusable.
    try {
      const ocResp = await ocGatewayPost("message", {
        action:     "send",
        channel:    "discord",
        target:     `channel:${GHOST_CHANNEL}`,
        message:    content,
        components: {
          reusable: true,
          blocks: [{
            type:    "actions",
            buttons: [
              { label: `✅ Send · ${draftId}`, style: "success" },
              { label: `❌ Cancel · ${draftId}`, style: "danger"  },
            ],
          }],
        },
      });

      // Parse messageId from OC response envelope
      try {
        // Prefer details.result.messageId (avoids JSON control-char parse issues in content text)
        messageId = ocResp?.result?.details?.result?.messageId
          || ocResp?.details?.result?.messageId
          || null;
        if (!messageId) {
          try {
            const textContent = ocResp?.result?.content?.[0]?.text;
            messageId = JSON.parse(textContent || "{}")?.result?.messageId || null;
          } catch {}
        }
      } catch {}

      if (messageId) {
        // GET the Discord message to find the OC-generated component custom_ids
        // Format: occomp:cid=<shortId>   Map label → action
        try {
          const dmStdout = await spawnAsync("curl", [
            "-s",
            `https://discord.com/api/v10/channels/${GHOST_CHANNEL}/messages/${messageId}`,
            "--config", "-",
          ], { timeout: 8000, input: discordAuthCurlConfig() });
          const dmsg     = tryParseJson(dmStdout);
          // Discord Components v2 (flags:32768): buttons are inside a container (type 17)
          // → action row (type 1) nested within. Flatten all type-2 components across all levels.
          const flattenButtons = (comps) => {
            const out = [];
            for (const c of (comps || [])) {
              if (c.type === 2) out.push(c);
              if (c.components) out.push(...flattenButtons(c.components));
            }
            return out;
          };
          const buttons  = flattenButtons(dmsg?.components || []);
          const registry = loadButtonRegistry();
          for (const btn of buttons) {
            const cid = (btn.custom_id || "");
            if (!cid.startsWith("occomp:cid=")) continue;
            const shortId = cid.replace("occomp:cid=", "");
            const label   = (btn.label || "").toLowerCase();
            const action  = label.includes("send") ? "send" : "cancel";
            registry[shortId] = {
              draftId,
              action,
              contactName,
              chatGuid: chatGuid || "",
              contact:  contact  || "",
              postedAt: new Date().toISOString(),
            };
          }
          saveButtonRegistry(registry);
          log(`Button registry updated for draft ${draftId} (shortIds: ${Object.keys(registry).slice(-2).join(", ")})`);
        } catch (err) {
          log(`postDraftToDiscord: failed to fetch Discord msg for shortId extraction — ${err.message.slice(0, 80)}`);
        }
      } else {
        log(`postDraftToDiscord: OC gateway returned no messageId — falling back to discordPost (raw buttons will NOT be registered; clicks will show 'expired'). OC resp: ${JSON.stringify(ocResp).slice(0, 200)}`);
      }
    } catch (err) {
      log(`postDraftToDiscord: OC gateway error (${err.message.slice(0, 80)}) — falling back`);
    }
  }

  // Fallback: raw Discord API (no-draft case, or if OC gateway failed)
  // IMPORTANT: do NOT post raw buttons here. They expire and cause "This component has expired".
  if (!messageId) {
    const fallbackContent = hasUsableDraft
      ? `${content}\n⚠️ Controls unavailable (gateway fallback). Auto-send only for this draft.`
      : content;
    const result = await discordPost(GHOST_CHANNEL, { content: fallbackContent });
    messageId = result?.id || null;
  }

  if (messageId && hasUsableDraft) {
    const drafts = loadPendingDrafts();
    drafts.push({
      messageId,
      draftId,
      chatGuid:    chatGuid || "",
      contact:     contact  || "",
      contactName: contactName,
      draftText:   draftResult.text,
      arrivedAt:   new Date(arrivedAt).toISOString(),
      postedAt:    new Date().toISOString(),
    });
    savePendingDrafts(drafts);
    log(`Pending draft saved: ${contactName} (${draftId})`);
  }
}

async function postUnknownAlert(phone, messageText, contactName, { source = "unknown", enrichment = null, alertCount = 1 } = {}) {
  const n        = normalizePhone(phone);
  const inApple  = source === "apple_contacts";
  const nameDisp = inApple ? `**${contactName}** (+${n})` : `+${n}`;
  const sourceLine = inApple
    ? `📒 Found in your Apple Contacts`
    : `❓ Not in Apple Contacts`;

  let content = `⚠️ **Unknown Contact** (${inApple ? "in your Contacts" : "not in Contacts"})\n`;
  content += `📞 ${nameDisp}\n`;
  content += `${sourceLine}\n`;
  if (enrichment?.emails?.length) content += `📧 ${enrichment.emails.slice(0,2).join(", ")}\n`;
  content += `💬 "${(messageText || "").slice(0, 200)}"`;
  if (alertCount > 1) content += `\n_Alert #${alertCount} — ${3 - alertCount + 1} remaining before auto-deny_`;
  // Text command fallback — buttons click visually but don't route to agent session
  // Typing in this channel DOES reach the ghost agent. Use text commands as the real action path.
  content += `\n\`approve ${n}\` · \`deny ${n}\``;

  // Post via OC gateway with reusable=true so buttons never expire.
  // Labels encode the phone so handler.js can parse them without a registry lookup.
  let messageId = null;
  if (OC_GATEWAY_TOKEN) {
    try {
      const ocResp = await ocGatewayPost("message", {
        action:  "send",
        channel: "discord",
        target:  `channel:${GHOST_CHANNEL}`,
        message: content,
        components: {
          reusable: true,
          blocks: [{
            type:    "actions",
            buttons: [
              { label: `✅ Approve · ${n}`, style: "success" },
              { label: `❌ Deny · ${n}`,    style: "danger"  },
            ],
          }],
        },
      });
      messageId = ocResp?.result?.details?.result?.messageId
        || ocResp?.details?.result?.messageId
        || null;
      if (!messageId) {
        try {
          const tc = ocResp?.result?.content?.[0]?.text;
          messageId = JSON.parse(tc || "{}")?.result?.messageId || null;
        } catch {}
      }
    } catch (err) {
      log(`postUnknownAlert: OC gateway failed (${err.message.slice(0, 80)}) — falling back`);
    }
  }

  // Fallback to raw Discord if OC gateway unavailable
  if (!messageId) {
    const result = await discordPost(GHOST_CHANNEL, { content });
    messageId = result?.id || null;
    if (messageId) log(`postUnknownAlert: OC gateway unavailable — posted without buttons (fallback). Buttons will not work.`);
  }

  // Track for repost limiting (max MAX_UNKNOWN_ALERTS per phone, then auto-deny)
  if (messageId) {
    const nowTs   = Date.now();
    // ocGateway=true → buttons are reusable, no need to refresh them
    const ocGateway = !!(OC_GATEWAY_TOKEN && messageId);
    pendingUnknownAlerts.set(n, {
      messageId, postedAt: nowTs, alertedAt: nowTs,
      alertCount,
      ocGateway,
      phone: n, messageText, contactName, source, enrichment,
    });
  }
}

// Max times we'll re-alert for the same unknown number before auto-denying them
const MAX_UNKNOWN_ALERTS = 3;

// Refresh unknown-contact alerts before Discord's 15-min interaction token expires.
// Runs every 12 min; deletes stale message + reposts fresh one for any unanswered alert.
// After MAX_UNKNOWN_ALERTS reposts, auto-denies the contact to stop the spam loop.
async function refreshUnknownAlerts() {
  if (!pendingUnknownAlerts.size) return;
  const REFRESH_MS = 12 * 60 * 1000; // 12 minutes
  const now = Date.now();
  // Snapshot stale entries BEFORE iterating — prevents re-visiting newly added entries
  // Skip entries posted via OC gateway: reusable=true buttons persist indefinitely, no refresh needed
  const stale = [...pendingUnknownAlerts.entries()].filter(([, e]) => {
    if (e.ocGateway) return false;  // OC reusable buttons — never need refreshing
    return now - e.postedAt >= REFRESH_MS;
  });
  for (const [phone, entry] of stale) {
    const n = normalizePhone(phone);
    // If the contact was added to the allowlist since the alert was first posted, cancel it
    if (isAllowed(`+${n}`)) {
      log(`Unknown-contact alert for +${n} is now on allowlist — cancelling stale alert`);
      if (entry.messageId) await discordDelete(GHOST_CHANNEL, entry.messageId).catch(() => {});
      pendingUnknownAlerts.delete(phone);
      continue;
    }
    const nextCount = (entry.alertCount || 1) + 1;
    // Max alerts reached — auto-deny to stop the spam loop
    if (nextCount > MAX_UNKNOWN_ALERTS) {
      log(`Unknown contact +${n} hit max alert limit (${MAX_UNKNOWN_ALERTS}) — auto-denying`);
      addToDenylist(n);
      if (entry.messageId) await discordDelete(GHOST_CHANNEL, entry.messageId).catch(() => {});
      pendingUnknownAlerts.delete(phone);
      discordPost(GHOST_CHANNEL, {
        content: `🚫 Auto-denied \`+${n}\` after ${MAX_UNKNOWN_ALERTS} unanswered alerts. Use \`/approve-contact +${n}\` to override.`,
      }).catch(() => {});
      continue;
    }
    log(`Refreshing unknown-contact alert for +${n} (alert #${nextCount}/${MAX_UNKNOWN_ALERTS})`);
    if (entry.messageId) await discordDelete(GHOST_CHANNEL, entry.messageId).catch(() => {});
    pendingUnknownAlerts.delete(phone);
    // Repost fresh — re-adds to the map with a new postedAt and incremented alertCount
    await postUnknownAlert(phone, entry.messageText, entry.contactName, {
      source: entry.source, enrichment: entry.enrichment, alertCount: nextCount,
    });
  }
}

/**
 * sweepStaleUnknownAlerts — auto-deny unknown contacts that haven't been approved in 4 waking hours.
 * Called every 30 minutes via setInterval in cmdServe().
 */
async function sweepStaleUnknownAlerts() {
  if (!pendingUnknownAlerts.size) return;
  const WAKING_HOURS_MS = 4 * 60 * 60 * 1000;
  const now = Date.now();
  const stale = [...pendingUnknownAlerts.entries()].filter(([, e]) => now - e.alertedAt > WAKING_HOURS_MS);
  for (const [phone, entry] of stale) {
    const n = normalizePhone(phone);
    log(`Unknown contact ${n} timed out — auto-denying`);
    addToDenylist(n);
    pendingUnknownAlerts.delete(phone);
    discordPost(GHOST_CHANNEL, {
      content: `🚫 Auto-denied \`+${n}\` (no approval after 4h). Use \`ghost-approve +${n}\` to override.`,
    }).catch(() => {});
  }
}

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
const MAX_MESSAGE_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours — BB replays old msgs on reconnect

async function runPreflight(contact, messageText, chatGuid, eventData) {
  const normalized = normalizePhone(contact);

  // -2. Reaction-event guard — skip tapback/emoji reactions without further processing
  // BlueBubbles may emit standalone reaction events where text == reaction label (e.g. "liked")
  if (eventData?.type === "reaction" || eventData?.isReaction === true) {
    return { ok: false, reason: "reaction_event" };
  }

  // -1. Age gate — skip messages older than 2 hours (BB replays stale msgs on reconnect)
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
      content: `⚠️ Prompt injection attempt from **${contactName}**: \`${(messageText || "").slice(0, 100)}\``,
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
    // Apple Contacts enrichment (best-effort, 3s timeout)
    let appleContactName = null;
    let appleEnrichment  = null;
    let alertSource      = "unknown";
    try {
      const cqResult = await Promise.race([
        mcporterCallAsync("bb_contact_query", { addresses: [`+${normalized}`] }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      const cqData = cqResult?.data?.[0] || cqResult?.data || null;
      if (cqData) {
        appleContactName = cqData.displayName ||
          [`${cqData.firstName || ""}`, `${cqData.lastName || ""}`].filter(Boolean).join(" ").trim() ||
          null;
        if (appleContactName) {
          alertSource    = "apple_contacts";
          appleEnrichment = {
            emails:   (cqData.emails || []).map(e => e.address).filter(Boolean),
            birthday: cqData.birthday || null,
          };
          log(`runPreflight: Apple Contacts match for +${normalized}: "${appleContactName}"`);
        }
      }
    } catch (err) {
      log(`runPreflight: Apple Contacts lookup failed for +${normalized}: ${(err.message || "").slice(0, 60)}`);
    }
    const { numToAlias } = loadContactsMap();
    const displayName = appleContactName || numToAlias[normalized] || `+${normalized}`;
    // Fire-and-forget — alert Klein without blocking the webhook response
    postUnknownAlert(normalized, messageText, displayName, {
      source:     alertSource,
      enrichment: appleEnrichment,
    }).catch(() => {});
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
  const messages = chatGuid ? await fetchRecentMessages(chatGuid, 10) : [];
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
  let { contact, contactName, messageText, sanitizedText, chatGuid, arrivedAt, autoSendMs } = entry;
  // Use sanitized text for model (strips links, media, secrets) — show original in Discord
  const modelText = sanitizedText || messageText;
  pendingMessages.delete(key);

  log(`checkAndDraft: ${contactName} (${key})`);

  // Quiet hours guard — don't draft outside 8am–11pm ET (uses existing isQuietHours)
  if (isQuietHours(contact)) {
    log(`checkAndDraft: quiet hours — skipping draft for ${contactName}`);
    return;
  }

  // BUG-2 guard: if chatGuid looks like a raw phone number (no semicolons),
  // resolve the real iMessage guid before proceeding.
  if (chatGuid && !chatGuid.includes(";")) {
    log(`chatGuid "${chatGuid}" looks like a raw phone — resolving...`);
    const resolved = await resolveChatGuid(chatGuid);
    if (resolved) {
      chatGuid = resolved;
    } else {
      log(`Could not resolve chatGuid for ${contactName} — draft aborted`);
      await discordPost(GHOST_CHANNEL, {
        content: `⚠️ **${contactName}**: could not resolve iMessage chatGuid — message not sent. Reply manually.`,
      });
      return;
    }
  }

  // Collision check — did Klein reply during the window?
  // normalizeTs: BB timestamps may be in seconds or ms; compare consistently in ms.
  const recent = await fetchRecentMessages(chatGuid, 10);
  if (recent.some(m => (m.isFromMe === true || m.from === "me") && normalizeTs(m.dateCreated || 0) > arrivedAt)) {
    log(`Klein already replied to ${contactName} — skipping draft`);
    return;
  }

  // Phase 3: live BB context — last 20 messages fetched at draft time
  const contextMessages = await fetchRecentMessages(chatGuid, 20);

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

  await postDraftToDiscord(draftResult, {
    chatGuid, contact, contactName, messageText, arrivedAt, contextMessages, autoSendMs,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  SEND HELPERS  (used by reaction check)
// ═══════════════════════════════════════════════════════════════════════════

/** "iMessage;-;+15551234567" (any service prefix) → "+15551234567"; null for anything else. */
function dmPhoneFromChatGuid(chatGuid) {
  const m = typeof chatGuid === "string" && chatGuid.match(/^[A-Za-z]+;-;(\+?\d+)$/);
  return m ? m[1] : null;
}

async function bbSendMessage(chatGuid, message) {
  const normalizedMessage = (message || "").toString().trim();
  if (!normalizedMessage) {
    log("bbSendMessage blocked: empty outbound message");
    return false;
  }

  if (hasInternalDriftMarkers(normalizedMessage)) {
    log(`bbSendMessage BLOCKED internal/pipeline marker for ${chatGuid || "unknown-chat"}`);
    return false;
  }

  // Verify DM recipient is in the Ghost contact allowlist (belt+suspenders against routing bugs).
  // Fail closed: a guid that is not a 1:1 phone DM (email handle, group, raw/unknown format)
  // cannot be checked against the phone-only allowlist, so it is never sent to.
  const dmPhone = dmPhoneFromChatGuid(chatGuid);
  if (!dmPhone) {
    log(`bbSendMessage BLOCKED: ${chatGuid || "unknown-chat"} is not a 1:1 phone chat`);
    return false;
  }
  if (!isAllowed(dmPhone) && normalizePhone(dmPhone) !== OWNER_PHONE_NORMALIZED) {
    log(`bbSendMessage BLOCKED: recipient ${chatGuid} not in contact allowlist`);
    return false;
  }

  // iMessageLite guids return 405 on send — swap to SMS equivalent immediately
  if (chatGuid && chatGuid.startsWith("iMessageLite;-;")) {
    const smsGuid = chatGuid.replace("iMessageLite;-;", "SMS;-;");
    log(`bbSendMessage: iMessageLite → swapping to ${smsGuid}`);
    chatGuid = smsGuid;
  }

  // Primary: mcporter → BB MCP (SSH tunnel)
  try {
    const argsJson = JSON.stringify({ chat_guid: chatGuid, message });
    const stdout   = await spawnAsync("mcporter", [
      "call", "bluebubbles.bb_send_message", "--args", argsJson,
    ], { timeout: 20000 });
    const resp = tryParseJson(stdout);
    if (resp?.status === 200) return true;
    log(`bbSendMessage MCP returned non-200: ${JSON.stringify(resp?.error || resp?.status)}`);
  } catch (err) {
    log(`bbSendMessage MCP failed (${err.message.slice(0, 80)}); trying direct BB...`);
  }

  // Fallback: direct BB HTTP API
  try {
    const result = await bbPost(`chat/${encodeURIComponent(chatGuid)}/message`, { message, method: "apple-script" });
    if (result?.status === 200) { log(`bbSendMessage direct BB ok`); return true; }
    log(`bbSendMessage direct BB returned: ${result?.status}`);
    return false;
  } catch (err) {
    log(`bbSendMessage direct BB error: ${err.message.slice(0, 80)}`);
    return false;
  }
}

async function kleinRepliedSince(chatGuid, sinceIso) {
  // Collision guard before auto-send: check BB for any message from owner since draft was posted
  try {
    const sinceMs  = new Date(sinceIso).getTime() - 30000; // 30s buffer (was 10s)
    const argsJson = JSON.stringify({ chat_guid: chatGuid, limit: 30, sort: "DESC" });
    const stdout   = await spawnAsync("mcporter", [
      "call", "bluebubbles.bb_get_chat_messages", "--args", argsJson,
    ], { timeout: 15000 });
    const data     = tryParseJson(stdout);
    // mcporter (MCP path) returns { messages: [...] } — use extractBBList to handle all formats
    // BB direct HTTP returns { data: [...] } — extractBBList handles that too
    const messages = extractBBList(data);
    // BB direct HTTP uses isFromMe:true; mcporter/MCP uses from:"me"
    // normalizeTs: BB timestamps may be in seconds or ms; compare consistently in ms.
    return messages.some(m => (m.isFromMe === true || m.from === "me") && normalizeTs(m.dateCreated || 0) > sinceMs);
  } catch (err) {
    log(`kleinRepliedSince check failed (blocking send): ${err.message.slice(0, 80)}`);
    return true; // Can't verify → don't send
  }
}

// Public wrapper — acquires per-contact send lock before calling inner logic
async function executeSend(draft, reason) {
  return withContactSendLock(draft.contact || draft.chatGuid || "", () => _executeSend(draft, reason));
}

async function _executeSend(draft, reason) {
  const { contactName, chatGuid, draftText, arrivedAt, postedAt, contact } = draft;

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

  // Quiet hours guard — applies to auto-send too, not just incoming messages
  if (reason === "auto-send" && isQuietHours(contact || chatGuid)) {
    log(`[${reason}] Quiet hours — holding draft for ${contactName} until morning`);
    // Keep in pending; it will fire when quiet hours lift
    return false;
  }

  // ── In-memory collision check (fix #6: prevents "cancelled but sent anyway" race) ──────
  // Check before hitting mcporter — faster and catches the race where outgoing webhook
  // fires concurrently with a running reaction check.
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
  if (collisionAnchor && await kleinRepliedSince(chatGuid, collisionAnchor)) {
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
  const ok = await bbSendMessage(chatGuid, draftText);

  if (ok) {
    await discordPost(GHOST_CHANNEL, { content: `✅ Sent to **${contactName}**: "${draftText}"` });
    logFeedback(draft, "sent");
    // Index outgoing message into embedding DB (non-blocking)
    indexMessage(contact, Date.now(), "me", draftText);
    // Update conversation state machine
    onGhostSend(contact);
    return true;
  } else {
    const retries = (draft.retries || 0) + 1;
    if (retries >= 3) {
      await discordPost(GHOST_CHANNEL, { content: `❌ Gave up after 3 failures for **${contactName}** — BB/MCP unavailable.` });
      return true;
    }
    draft.retries = retries;
    log(`Send failed for ${contactName} (attempt ${retries}/3)`);
    return false; // keep in pending
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  REACTION CHECK  (embedded — replaces ghost-reaction-check.sh cron)
// ═══════════════════════════════════════════════════════════════════════════

async function doReactionCheck() {
  // File lock — skip if another check is still running
  let lockFd;
  try { lockFd = fs.openSync(LOCK_FILE, "wx"); } catch { return; }

  try {
    if (isPaused()) { log("Ghost paused — skipping reaction check"); return; }

    const drafts        = loadPendingDrafts();
    if (!drafts.length) return;

    const buttonActions = loadJson(BUTTON_ACTIONS_FILE, []);
    const actionMap     = {};   // draftId → "send" | "cancel"
    const consumed      = new Set();
    const approveQ      = [], denyQ = [];

    for (let i = 0; i < buttonActions.length; i++) {
      const ba  = buttonActions[i];
      const cid = (ba.custom_id || "").toString();
      const did = ba.draftId || "";
      const act = (ba.action || "").toLowerCase();

      if (cid.startsWith("approve_")) { approveQ.push(cid.replace("approve_", "")); consumed.add(i); continue; }
      if (cid.startsWith("deny_"))    { denyQ.push(cid.replace("deny_", ""));       consumed.add(i); continue; }
      if (cid.startsWith("GHOST_SEND:"))   { const id = cid.split(":")[1]; if (id) { actionMap[id] = "send";   consumed.add(i); } continue; }
      if (cid.startsWith("GHOST_CANCEL:")) { const id = cid.split(":")[1]; if (id) { actionMap[id] = "cancel"; consumed.add(i); } continue; }
      if (did && act) { actionMap[did] = act; consumed.add(i); }
    }

    // Contact management — enrich from Apple Contacts on approve
    // Clear any pending unknown-alert refresh entries for acted-on phones
    for (const phone of [...approveQ, ...denyQ]) pendingUnknownAlerts.delete(phone);

    for (const phone of approveQ) {
      let name = "Unknown";
      let source = "discord_approve";  // BUG-4 FIX: writes "Approved via Discord" note to CONTACTS.md
      let enrichOpts = {};
      try {
        const r = spawnSync("mcporter", [
          "call", "bluebubbles.bb_contact_query",
          "--args", JSON.stringify({ addresses: [`+${normalizePhone(phone)}`] }),
        ], { encoding: "utf8", timeout: 4000, env: { ...process.env, HOME } });
        const cqData = (() => { try { return JSON.parse(r.stdout)?.data?.[0]; } catch { return null; } })();
        if (cqData) {
          const resolved = cqData.displayName ||
            [`${cqData.firstName || ""}`, `${cqData.lastName || ""}`].filter(Boolean).join(" ").trim();
          if (resolved) {
            name   = resolved;
            // Keep source as "discord_approve" — always write "Approved via Discord" to CONTACTS.md.
            // Still pull name/emails/birthday from Apple Contacts for richer entries.
            enrichOpts = {
              emails:   (cqData.emails || []).map(e => e.address).filter(Boolean),
              birthday: cqData.birthday || null,
            };
            log(`Approve enriched: +${normalizePhone(phone)} → "${name}" from Apple Contacts`);
          }
        }
      } catch {}
      try { addToAllowlist(phone, name, { source, ...enrichOpts }); }
      catch (err) { log(`Approve skipped for "${phone}": ${err.message}`); }
    }
    for (const phone of denyQ) {
      try { addToDenylist(phone); }
      catch (err) { log(`Deny skipped for "${phone}": ${err.message}`); }
    }

    const now  = Date.now();
    const keep = [];
    const alreadySentThisCycle = new Set();

    const sortedDrafts = [...drafts].sort((a, b) => new Date(b.arrivedAt || 0) - new Date(a.arrivedAt || 0));
    for (const draft of sortedDrafts) {
      const { draftId, contactName, postedAt } = draft;
      const age     = now - new Date(postedAt || now).getTime();
      const expired = age > 24 * 60 * 60 * 1000;

      if (expired) { log(`Expired draft for ${contactName} — removing`); continue; }

      const action = actionMap[draftId];

      // ── In-memory cancel guard (race fix #1) ──────────────────────────────
      // Prune expired TTLs first
      for (const [id, exp] of cancelledDraftTtl.entries()) {
        if (Date.now() > exp) { cancelledDraftIds.delete(id); cancelledDraftTtl.delete(id); }
      }
      if (cancelledDraftIds.has(draftId)) {
        log(`doReactionCheck: draft ${draftId} was in-memory cancelled (HTTP /action) — skipping auto-send`);
        logFeedback(draft, "cancelled");
        cancelledDraftIds.delete(draftId);
        cancelledDraftTtl.delete(draftId);
        continue;
      }

      if (action === "cancel") {
        log(`❌ Cancel: ${contactName} (${draftId})`);
        await discordPost(GHOST_CHANNEL, { content: `❌ Cancelled draft for **${contactName}**.` });
        logFeedback(draft, "cancelled");
        continue;
      }

      if (action === "send") {
        log(`✅ Send button: ${contactName}`);
        const ok = await executeSend(draft, "button:send");
        if (!ok) keep.push(draft);
        continue;
      }

      // No button action yet — check if auto-send window has elapsed
      const autoSendMs = draft.autoSendMs || AUTO_SEND_WINDOW_MS;
      if (autoSendMs > 0 && age >= autoSendMs) {
        // Race guard: if cancelled via HTTP /action or outgoing webhook WHILE this check was running
        if (cancelledDraftIds.has(draftId)) {
          log(`Auto-send: draft ${draftId} was cancelled in-memory — skipping race victim`);
          logFeedback(draft, "cancelled");
          cancelledDraftIds.delete(draftId);
          continue;
        }
        if (alreadySentThisCycle.has(draft.chatGuid)) {
          log(`Auto-send: skipping older draft for ${contactName} (newer draft already sent this cycle)`);
          logFeedback(draft, "superseded");
          continue;
        }
        if (isQuietHours(draft.contact || draft.chatGuid)) {
          log(`Auto-send: quiet hours — deferring draft for ${contactName}`);
          keep.push(draft);
          continue;
        }
        if (await kleinRepliedSince(draft.chatGuid, draft.arrivedAt || draft.postedAt)) {
          log(`Auto-send: Klein already replied to ${contactName} — cancelling draft`);
          logFeedback(draft, "auto-cancelled-collision");
          await discordPost(GHOST_CHANNEL, { content: `↩️ Auto-cancelled: **${contactName}** already replied to manually.` });
          continue;
        }
        log(`Auto-send: ${contactName} (${draftId}, age ${Math.round(age / 60000)}min)`);
        const ok = await executeSend(draft, "auto-send");
        if (ok) alreadySentThisCycle.add(draft.chatGuid);
        if (!ok) keep.push(draft);
        continue;
      }

      keep.push(draft);
    }

    // The loop above awaits network calls, so the drafts file may have changed underneath us:
    // new drafts posted (must not be dropped) or drafts removed by /action send|cancel or an
    // outgoing-message webhook (must not be resurrected, or they could auto-send again).
    const snapshotIds = new Set(drafts.map(d => d.draftId));
    const current     = loadPendingDrafts();
    const currentIds  = new Set(current.map(d => d.draftId));
    savePendingDrafts([
      ...keep.filter(d => currentIds.has(d.draftId)),
      ...current.filter(d => !snapshotIds.has(d.draftId)),
    ]);
    saveJson(BUTTON_ACTIONS_FILE, buttonActions.filter((_, i) => !consumed.has(i)));

  } finally {
    try { fs.closeSync(lockFd); fs.unlinkSync(LOCK_FILE); } catch {}
  }
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

/**
 * Who may call which endpoint. The server listens on all interfaces (BlueBubbles posts from
 * another host), so anything on the LAN can reach it.
 *   "control" (/action, /approve-contact, /deny-contact, /pending): loopback (the local
 *             OpenClaw hook), or a valid GHOST_API_TOKEN.
 *   "webhook" (/bluebubbles/message-sent): a valid token when GHOST_API_TOKEN is set;
 *             open otherwise, for backwards compatibility.
 */
function isAuthorizedRequest(req, scope, token = GHOST_API_TOKEN) {
  if (scope === "control") return isLoopbackAddress(req.socket?.remoteAddress) || requestHasValidToken(req, token);
  if (scope === "webhook") return !token || requestHasValidToken(req, token);
  return true;
}

function createServer() {
  return http.createServer(async (req, res) => {
    let bodyTooLarge = false;
    const send = (status, body) => {
      if (res.headersSent) return;
      if (bodyTooLarge) status = 413;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // Bounded body reader: past MAX_BODY_BYTES the rest is drained and discarded (not buffered).
    const readBody = () => new Promise((resolve, reject) => {
      let b = "", size = 0;
      req.on("data", c => {
        size += c.length;
        if (size > MAX_BODY_BYTES) bodyTooLarge = true;
        else b += c;
      });
      req.on("end", () => bodyTooLarge ? reject(new Error("payload too large")) : resolve(b));
      req.on("error", reject);
    });

    // Route on the path only so the BB webhook URL can carry ?token=…
    let pathname = "/";
    try { pathname = new URL(req.url || "/", "http://localhost").pathname; } catch {}
    const CONTROL_ROUTES = ["/pending", "/approve-contact", "/deny-contact", "/action"];
    const scope = CONTROL_ROUTES.includes(pathname) ? "control"
      : pathname === "/bluebubbles/message-sent" ? "webhook" : "public";
    if (!isAuthorizedRequest(req, scope)) {
      log(`Rejected unauthorized ${req.method} ${pathname} from ${req.socket?.remoteAddress || "?"}`);
      return send(401, { ok: false, error: "unauthorized" });
    }

    // GET /health
    if (req.method === "GET" && pathname === "/health") {
      return send(200, { ok: true, service: "ghost-v3", paused: isPaused(), pending: pendingMessages.size });
    }

    // GET /pending
    if (req.method === "GET" && pathname === "/pending") {
      const list = [...pendingMessages.entries()].map(([k, v]) => ({
        key: k, contactName: v.contactName,
        arrivedAt: new Date(v.arrivedAt).toISOString(),
        firesAt:   new Date(v.arrivedAt + DRAFT_DELAY_MS).toISOString(),
      }));
      return send(200, { ok: true, pending: list });
    }

    // POST /approve-contact
    if (req.method === "POST" && pathname === "/approve-contact") {
      try {
        const { phone, name } = JSON.parse(await readBody());
        if (!phone) throw new Error("phone required");
        // Enrich from Apple Contacts (best-effort, 4s timeout)
        let resolvedName = name && name !== "Unknown" ? name : null;
        let enrichOpts   = {};
        try {
          const r = spawnSync("mcporter", [
            "call", "bluebubbles.bb_contact_query",
            "--args", JSON.stringify({ addresses: [`+${normalizePhone(phone)}`] }),
          ], { encoding: "utf8", timeout: 4000, env: { ...process.env, HOME } });
          const cqData = (() => { try { return JSON.parse(r.stdout)?.data?.[0]; } catch { return null; } })();
          if (cqData) {
            const fullName = cqData.displayName ||
              [`${cqData.firstName || ""}`, `${cqData.lastName || ""}`].filter(Boolean).join(" ").trim();
            if (fullName) {
              resolvedName = fullName;
              enrichOpts = {
                emails:   (cqData.emails || []).map(e => e.address).filter(Boolean),
                birthday: cqData.birthday || null,
              };
              log(`/approve-contact: enriched +${normalizePhone(phone)} → "${fullName}"`);
            }
          }
        } catch {}
        addToAllowlist(phone, resolvedName || "Unknown", { source: "discord_approve", ...enrichOpts });
        // Remove from pending unknown alerts map
        pendingUnknownAlerts.delete(normalizePhone(phone));
        await discordPost(GHOST_CHANNEL, { content: `✅ Approved **${resolvedName || phone}** — added to allowlist.` });
        return send(200, { ok: true, action: "approved", phone, name: resolvedName || "Unknown" });
      } catch (e) { return send(400, { ok: false, error: e.message }); }
    }

    // POST /deny-contact
    if (req.method === "POST" && pathname === "/deny-contact") {
      try {
        const { phone } = JSON.parse(await readBody());
        if (!phone) throw new Error("phone required");
        addToDenylist(phone);
        // Remove from pending unknown alerts map — stops refresh loop
        pendingUnknownAlerts.delete(normalizePhone(phone));
        await discordPost(GHOST_CHANNEL, { content: `🚫 Denied \`+${normalizePhone(phone)}\` — added to denylist.` });
        return send(200, { ok: true, action: "denied", phone });
      } catch (e) { return send(400, { ok: false, error: e.message }); }
    }

    // POST /action — triggered by pre-message hook for button clicks (both OC and legacy)
    if (req.method === "POST" && pathname === "/action") {
      try {
        const { draftId, action, userId } = JSON.parse(await readBody());
        if (!draftId || !action) return send(400, { ok: false, error: "draftId and action required" });
        // Require userId to match when KLEIN_DISCORD_USER_ID is configured — absent userId also fails
        if (KLEIN_DISCORD_USER_ID && userId !== KLEIN_DISCORD_USER_ID) {
          return send(403, { ok: false, error: "unauthorized" });
        }
        const drafts   = loadPendingDrafts();
        const draftIdx = drafts.findIndex(d => d.draftId === draftId);
        if (draftIdx === -1) return send(404, { ok: false, error: "draft not found" });
        const draft = drafts[draftIdx];
        if (action === "cancel") {
          // Register in-memory cancellation FIRST — prevents doReactionCheck auto-send race
          cancelledDraftIds.add(draftId);
          cancelledDraftTtl.set(draftId, Date.now() + 10 * 60 * 1000); // 10-min TTL
          logFeedback(draft, "cancelled");
          drafts.splice(draftIdx, 1);
          savePendingDrafts(drafts);
          await discordPost(GHOST_CHANNEL, { content: `❌ Cancelled draft for **${draft.contactName}**.` });
          return send(200, { ok: true, action: "cancelled" });
        }
        if (action === "send") {
          const ok = await executeSend(draft, "button:send");
          if (ok) {
            const updated = loadPendingDrafts().filter(d => d.draftId !== draftId);
            savePendingDrafts(updated);
          }
          return send(200, { ok: true, action: ok ? "sent" : "send_failed" });
        }
        return send(400, { ok: false, error: `unknown action: ${action}` });
      } catch (e) { return send(400, { ok: false, error: e.message }); }
    }

    // POST /bluebubbles/message-sent  ← main webhook
    if (req.method === "POST" && pathname === "/bluebubbles/message-sent") {
      try {
        const body = await readBody();
        log(`Webhook recv: ${body.slice(0, 200)}`);
        const event     = parseIncomingEvent(body, req.headers["content-type"]);
        const eventType = (event?.type || "").toLowerCase();
        const eventData = (event?.data && typeof event.data === "object") ? event.data : {};

        const isFromMe  = eventData?.isFromMe === true;
        const chatGuid  = typeof eventData.chatGuid === "string" ? eventData.chatGuid : "";
        const contact   = extractContactPhone(eventData);

        if (!["new-message", "message-send", "message-receive"].includes(eventType)) {
          return send(200, { ok: true, action: "ignored", type: eventType });
        }

        // Drop group chats
        if (isGroupChatGuid(chatGuid, eventData)) {
          log(`Group chat — skipping (chatGuid: ${chatGuid || "none"})`);
          return send(200, { ok: true, action: "ignored", reason: "group_chat" });
        }

        const normalized = normalizePhone(contact);

        if (isDuplicateInboundEvent(eventType, eventData)) {
          log(`Duplicate webhook event dropped (${eventType}) for ${normalized || chatGuid || "unknown"}`);
          return send(200, { ok: true, action: "ignored", reason: "duplicate_event" });
        }

        // Outgoing: Klein sent a message — cancel pending draft for this chat
        if (isFromMe || normalized === OWNER_PHONE_NORMALIZED) {
          const key = chatGuid || normalized;
          let cancelled = false;

          // Update in-memory reply tracker (prevents executeSend race condition — fix #6)
          const replyTs = Date.now();
          if (key)        kleinRepliedRecentlyChats.set(key, replyTs);
          if (normalized) kleinRepliedRecentlyChats.set(normalized, replyTs);
          // Prune entries older than 30 min
          for (const [k, ts] of kleinRepliedRecentlyChats.entries()) {
            if (replyTs - ts > 30 * 60 * 1000) kleinRepliedRecentlyChats.delete(k);
          }

          // 1. Cancel in-memory pending (pre-draft, within 30s window)
          if (key && pendingMessages.has(key)) {
            clearTimeout(pendingMessages.get(key).timeoutId);
            pendingMessages.delete(key);
            log(`Klein replied to ${key} — cancelled in-memory pending draft`);
            cancelled = true;
          }

          // 2. Cancel any already-posted draft for this chat (in ghost-pending-drafts.json)
          //    This fires when Klein replies AFTER the draft was already posted to Discord.
          const postedDrafts = loadPendingDrafts();
          const toCancel = postedDrafts.filter(d =>
            d.chatGuid === key ||
            d.chatGuid === chatGuid ||
            normalizePhone(d.contact) === normalized
          );
          if (toCancel.length > 0) {
            const remaining = postedDrafts.filter(d => !toCancel.includes(d));
            savePendingDrafts(remaining);
            for (const draft of toCancel) {
              // Register in-memory cancellation — closes the race with doReactionCheck
              cancelledDraftIds.add(draft.draftId);
              log(`Klein outgoing — cancelled posted draft ${draft.draftId} for ${draft.contactName}`);
              logFeedback(draft, "auto-cancelled-klein-replied");
              discordPost(GHOST_CHANNEL, {
                content: `↩️ Cancelled draft for **${draft.contactName}** — Klein already replied.`,
              }).catch(() => {});
            }
            cancelled = true;
          }

          return send(200, { ok: true, action: cancelled ? "draft_cancelled" : "outgoing_noop" });
        }

        if (!contact || !normalized) return send(200, { ok: true, action: "drop", reason: "no_contact" });

        const messageText = extractMessageText(eventData);

        // Phase 0: Preflight — requiresReply, spam, denied, allowed, group, quiet hours, fetch context
        const preflight = await runPreflight(contact, messageText, chatGuid, eventData);
        if (!preflight.ok) {
          log(`Preflight skip: ${preflight.reason} for ${normalized}`);
          if (preflight.reason === "unknown_contact") {
            return send(200, { ok: true, action: "unknown_contact_alert", resolvedName: preflight.resolvedName, source: preflight.source });
          }
          if (preflight.reason === "spam") {
            // Auto-deny known spam callers that slipped through (short-codes, etc.)
            if (!isAllowed(contact)) { addToDenylist(normalized); log(`Auto-denied spam: ${normalized}`); }
            return send(200, { ok: true, action: "drop", reason: "auto_deny_spam" });
          }
          return send(200, { ok: true, action: preflight.reason });
        }

        if (isPaused()) { log(`Paused — skipping ${normalized}`); return send(200, { ok: true, action: "paused" }); }

        const { contactName } = preflight.context;
        const arrivedAt     = Date.now();
        const key           = chatGuid || normalized;

        // If a posted draft already exists for this contact/chat, don't queue another.
        // This prevents duplicate draft cards when multiple messages arrive before action is taken.
        const postedDrafts = loadPendingDrafts();
        const activeDraft = postedDrafts.find(d =>
          normalizePhone(d.contact) === normalized || d.chatGuid === key || d.chatGuid === chatGuid
        );
        if (activeDraft) {
          log(`Existing posted draft ${activeDraft.draftId} for ${contactName} — skipping re-queue`);
          return send(200, {
            ok: true,
            action: "draft_already_posted",
            contactName,
            chatGuid: key,
            draftId: activeDraft.draftId,
          });
        }

        // Replace existing pending for same chat (debounce rapid messages)
        // ISSUE-8 fix: also remove old draft from ghost-pending-drafts.json so it doesn't auto-send stale context
        if (pendingMessages.has(key)) {
          clearTimeout(pendingMessages.get(key).timeoutId);
          log(`Debounced pending for ${key}`);
          // Remove the stale draft from persistent pending and notify Discord
          const staleDrafts = loadPendingDrafts();
          const staleEntry  = staleDrafts.find(d => d.contact === normalized || d.chatGuid === key);
          if (staleEntry) {
            savePendingDrafts(staleDrafts.filter(d => d.draftId !== staleEntry.draftId));
            discordPost(GHOST_CHANNEL, {
              content: `⚠️ Draft superseded for **${contactName}** — new message arrived, regenerating. Old draft discarded.`,
            }).catch(() => {});
            log(`Removed stale draft ${staleEntry.draftId} for ${contactName} (superseded)`);
          }
        }

        // Update conversation state machine — contact sent us a message
        onContactMessage(contact);
        // Index incoming message into embedding DB (non-blocking)
        indexMessage(contact, arrivedAt, "them", messageText);

        const cooldownMs = getCooldownMs(contact);
        const timeoutId = setTimeout(() => checkAndDraft(key), DRAFT_DELAY_MS);
        pendingMessages.set(key, { contact, contactName, messageText, sanitizedText: preflight.context.sanitizedText, chatGuid: chatGuid || key, arrivedAt, timeoutId, contextMessages: preflight.context.messages, autoSendMs: cooldownMs });
        log(`Draft queued for ${contactName} — fires in ${DRAFT_DELAY_MS / 60000}min (cooldown: ${Math.round(cooldownMs/1000)}s)`);

        return send(200, {
          ok: true, action: "draft_scheduled",
          contactName, chatGuid: key,
          draftFiresAt: new Date(arrivedAt + DRAFT_DELAY_MS).toISOString(),
          autoSendAt:   new Date(arrivedAt + DRAFT_DELAY_MS + cooldownMs).toISOString(),
        });

      } catch (err) {
        log(`Webhook error: ${err.message}`);
        return send(400, { ok: false, error: err.message });
      }
    }

    send(404, { ok: false, error: "Not found" });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  LEARNING PIPELINE  (Phase 1)
// ═══════════════════════════════════════════════════════════════════════════

async function mcporterCallSync(tool, argsObj) {
  // Sync variant for learn CLI ONLY — do NOT use in the webhook/serve path (blocks event loop).
  const result = spawnSync("mcporter", [
    "call", `bluebubbles.${tool}`, "--args", JSON.stringify(argsObj),
  ], { encoding: "utf8", timeout: 60000, env: { ...process.env, HOME } });
  if (result.status !== 0) throw new Error(`mcporter ${tool}: ${result.stderr?.slice(0, 200)}`);
  return JSON.parse(result.stdout);
}

async function mcporterCallAsync(tool, argsObj) {
  // Non-blocking async variant — use this in the webhook/serve path.
  const stdout = await spawnAsync("mcporter", [
    "call", `bluebubbles.${tool}`, "--args", JSON.stringify(argsObj),
  ], { timeout: 60000 });
  return JSON.parse(stdout);
}

/** Normalize the array payload out of a BB MCP response regardless of key name. */
function extractBBList(data) {
  if (!data) return [];
  // bb_list_chats returns { chats: [...] }
  // bb_get_chat_messages returns { messages: [...] } or { data: [...] }
  if (Array.isArray(data))             return data;
  if (Array.isArray(data.chats))       return data.chats;
  if (Array.isArray(data.messages))    return data.messages;
  if (Array.isArray(data.data))        return data.data;
  if (Array.isArray(data.contacts))    return data.contacts;
  return [];
}

/**
 * Returns true if the chatGuid (or event data) indicate a group chat.
 * Direct messages use ";-;" separator across all protocols (iMessage, SMS, iMessageLite, RCS).
 * Group chats use ";+;" separator (e.g. "iMessage;+;chat123456789").
 *
 * BB sometimes fires group-chat webhooks with the individual sender's handle rather than
 * the group chatGuid — so we also check participants, chats array, and groupName field.
 */
function isGroupChatGuid(chatGuid, eventData = {}) {
  // Primary: chatGuid format (most reliable when present)
  if (chatGuid && chatGuid.includes(";+;")) return true;

  // Secondary: participants list on the event itself (> 1 means group)
  if (Array.isArray(eventData.participants) && eventData.participants.length > 1) return true;

  // Tertiary: BB sometimes embeds a `chats` array — if any entry is a group chat, block it
  if (Array.isArray(eventData.chats)) {
    if (eventData.chats.some(c => (c.guid || c.chatGuid || "").includes(";+;"))) return true;
    if (eventData.chats.some(c => Array.isArray(c.participants) && c.participants.length > 1)) return true;
  }

  // Quaternary: explicit group name field (BB sets this for named group chats)
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
    if (!matched && normalizePhone(chat.chatIdentifier || "") === n) matched = true;
    if (!matched && typeof chat.guid === "string" && chat.guid.includes(`;-;+${n.slice(-10)}`)) matched = true;
    if (matched) hits.push(chat);
  }

  // Score: iMessage;-; > SMS;-;/RCS;-; > iMessageLite;-; (405s on send) > group > other
  const score = (c) => {
    const g = c.guid || "";
    const is1on1 = (c.participants || []).length <= 1;
    if (g.startsWith("iMessage;-;"))     return is1on1 ? 0 : 3;
    if (g.startsWith("SMS;-;") || g.startsWith("RCS;-;")) return is1on1 ? 1 : 4;
    if (g.startsWith("iMessageLite;-;")) return is1on1 ? 2 : 5; // last resort — BB returns 405 on send
    if (g.includes(";+;"))               return 6;
    return 7;
  };
  hits.sort((a, b) => score(a) - score(b));
  return hits;
}

// Legacy single-result wrapper
function findChatGuidForPhone(phone, allChats) {
  return findChatsForPhone(phone, allChats)[0]?.guid || null;
}

function isFromKlein(m) {
  // BB direct HTTP uses isFromMe:true; mcporter uses from:"me"
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

  // Enrich from Apple Contacts first
  let appleContactSection = "";
  try {
    const cqData = await mcporterCallSync("bb_contact_query", { addresses: [contact.phone] });
    const ac = extractBBList(cqData)[0];
    if (ac) {
      const fullName = ac.displayName ||
        [`${ac.firstName || ""}`, `${ac.lastName || ""}`].filter(Boolean).join(" ").trim();
      const emailList = (ac.emails || []).map(e => e.address).filter(Boolean);
      const altNums   = (ac.phoneNumbers || []).slice(1).map(p => p.address).filter(Boolean);
      appleContactSection = [
        `## Apple Contacts Record`,
        fullName ? `- Full name: ${fullName}` : "",
        emailList.length ? `- Emails: ${emailList.join(", ")}` : "",
        ac.birthday ? `- Birthday: ${ac.birthday}` : "",
        altNums.length ? `- Alternate numbers: ${altNums.join(", ")}` : "",
      ].filter(Boolean).join("\n") + "\n\n";
      log(`  Apple Contacts enriched: ${fullName || "(name from allowlist)"}`);
    }
  } catch (err) {
    log(`  Apple Contacts enrichment skipped: ${(err.message || "").slice(0, 60)}`);
  }

  const candidateChats = findChatsForPhone(contact.phone, allChats);
  if (!candidateChats.length) { log(`No chat found for ${contact.alias}`); return null; }

  // Try each chat in ranked order until we get actual messages
  let messages = [], chatGuid = null;
  for (const chat of candidateChats) {
    log(`Trying chatGuid: ${chat.guid}`);
    try {
      // Use higher limit for family_close contacts (high message frequency)
      const msgLimit = (contact.category === "family_close") ? 750 : 500;
      const data = await mcporterCallSync("bb_get_chat_messages", { chat_guid: chat.guid, limit: msgLimit, sort: "DESC" });
      const msgs = extractBBList(data);
      if (msgs.length > 0) { messages = msgs; chatGuid = chat.guid; break; }
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
  let summary = await tryGeminiCli(prompt, { timeoutMs: 45000 });
  if (!summary) {
    log(`Gemini CLI failed — trying OR gemma-27b...`);
    summary = (await tryOpenRouter("google/gemma-3-27b-it:free", "", prompt, 30000))?.text || null;
  }
  if (!summary) {
    summary = `## Who They Are\n${contact.alias} (${contact.name})\n\n## Sample Klein Messages\n${stats.examples}`;
    log(`All models failed — writing stats-only stub for ${contact.alias}`);
  }

  const filename = `${contact.phone}-${contact.alias.toLowerCase().replace(/\s+/g, "-")}.md`;
  const filepath = path.join(CONTACTS_MEMORY_DIR, filename);
  fs.mkdirSync(CONTACTS_MEMORY_DIR, { recursive: true });
  writeFileSafe(filepath, `# Contact Memory: ${contact.alias}\n_Updated: ${new Date().toISOString().slice(0, 10)}_\n\n${appleContactSection}${summary}\n`);
  log(`Saved: ${filepath}`);
  return summary;
}

async function buildVoiceProfile(summaries) {
  const combined = Object.entries(summaries)
    .map(([name, s]) => `### ${name}\n${s}`)
    .join("\n\n---\n\n");

  const prompt = `You are writing a voice profile for Ghost — Klein's AI auto-reply system.

Klein is a college student at VT. Here are cross-contact summaries of his texting style:

${combined || "(no summaries yet)"}

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
  let profile = await tryGeminiCli(prompt, { timeoutMs: 45000 });
  if (!profile) profile = (await tryOpenRouter("google/gemma-3-27b-it:free", "", prompt, 30000))?.text || null;
  if (!profile) profile = `## Core Typography\nLowercase, no period at end, contractions without apostrophes common.\n\n## Universal Vocabulary\nyea, nah, bet, fs, idk, tbh, lowkey, bruh, bro, lol (sparingly)`;

  writeFileSafe(VOICE_PROFILE_FILE, `# Klein Voice Profile\n_Updated: ${new Date().toISOString().slice(0, 10)}_\n\n${profile}\n`);
  log(`Voice profile saved: ${VOICE_PROFILE_FILE}`);
}

async function cmdLearn(args) {
  const targetPhone = args.includes("--contact") ? args[args.indexOf("--contact") + 1] : null;
  log("ghost learn starting...");
  fs.mkdirSync(CONTACTS_MEMORY_DIR, { recursive: true });

  log("Fetching chats from BlueBubbles via mcporter...");
  let allChats = [];
  try {
    // Paginate through all chats to guarantee we find direct iMessage;-; threads
    let offset = 0;
    while (true) {
      const data  = await mcporterCallSync("bb_list_chats", { limit: 300, offset });
      const batch = extractBBList(data);
      if (!batch.length) break;
      allChats.push(...batch);
      if (batch.length < 300) break;
      offset += 300;
    }
    log(`Got ${allChats.length} chats (paginated)`);
  } catch (err) {
    console.error(`Failed to fetch chats: ${err.message}`);
    console.error("Make sure mcporter and BlueBubbles are running.");
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

  for (const c of contacts) {
    const s = await learnContact(c, allChats);
    if (s) summaries[c.alias] = s;
    await new Promise(r => setTimeout(r, 1500)); // small breathe between contacts
  }

  if (!targetPhone || args.includes("--voice-profile")) {
    await buildVoiceProfile(summaries);
  }

  const done = Object.keys(summaries).length;
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

function purgeStaleDrafts() {
  // On startup, nuke drafts older than 1h to prevent auto-send firehose after restart.
  // Any draft older than 1h means the service was down for a while; Klein may have already
  // replied manually. Discard and notify Discord rather than risk ghost-texting stale replies.
  try {
    const drafts = loadPendingDrafts();
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
    const clean  = drafts.filter(d => d.draftText && new Date(d.postedAt || 0).getTime() > cutoff);
    const purged = drafts.length - clean.length;
    if (purged > 0) {
      savePendingDrafts(clean);
      log(`Purged ${purged} stale/empty drafts on startup (>1h old)`);
      // Async-notify Discord so Klein knows ghost had pending drafts that were dropped
      const contacts = [...new Set(drafts.filter(d => new Date(d.postedAt || 0).getTime() <= cutoff).map(d => d.contactName))].join(", ");
      discordPost(GHOST_CHANNEL, {
        content: `⚠️ **Ghost restarted** — purged **${purged}** stale draft(s) (>1h old, not sent).\nAffected: ${contacts || "unknown"}\nCheck if manual replies are needed.`
      }).catch(() => {});
    }
  } catch {}
}

async function pruneStaleDraftsOnStartup() {
  const drafts = loadPendingDrafts();
  if (!drafts.length) return;
  const keep = [];
  for (const draft of drafts) {
    const alreadyReplied = await kleinRepliedSince(draft.chatGuid, draft.arrivedAt || draft.postedAt);
    if (alreadyReplied) {
      log(`Startup: Klein already replied to ${draft.contactName} — discarding stale draft ${draft.draftId}`);
    } else {
      keep.push(draft);
    }
  }
  savePendingDrafts(keep);
  if (keep.length < drafts.length) {
    log(`Startup: pruned ${drafts.length - keep.length} stale draft(s) where Klein already replied`);
  }
}

function cmdServe() {
  // Clear any stale lock from a prior crash before starting reaction check loop
  try { fs.unlinkSync(LOCK_FILE); } catch {}
  purgeStaleDrafts();
  pruneStaleDraftsOnStartup().catch(err => log(`Startup preflight error: ${err.message}`));
  const server = createServer();
  server.listen(PORT, BIND_HOST, () => {
    log(`Ghost v3 listening on ${BIND_HOST}:${PORT}`);
    log(`  Webhook : http://<this-host>:${PORT}/bluebubbles/message-sent${GHOST_API_TOKEN ? "?token=…" : ""}`);
    if (!GHOST_API_TOKEN) log(`  WARNING : GHOST_API_TOKEN unset — webhook accepts unauthenticated posts from any host`);
    log(`  Health  : http://127.0.0.1:${PORT}/health`);
    log(`  Pending : http://127.0.0.1:${PORT}/pending`);
    log(`  Reaction check: every ${REACT_CHECK_INTERVAL_MS / 1000}s (embedded)`);
  });

  // Embedded reaction-check loop (no external cron needed)
  setInterval(() => {
    doReactionCheck().catch(err => log(`Reaction check error: ${err.message}`));
  }, REACT_CHECK_INTERVAL_MS);

  // Auto-refresh unknown-contact alerts every 12 min so buttons never go stale
  const UNKNOWN_REFRESH_MS = 12 * 60 * 1000;
  setInterval(() => {
    refreshUnknownAlerts().catch(err => log(`Unknown alert refresh error: ${err.message}`));
  }, UNKNOWN_REFRESH_MS);

  // Sweep stale unknown contacts every 30 min — auto-deny after 4 waking hours
  setInterval(() => {
    sweepStaleUnknownAlerts().catch(err => log(`Sweep stale unknown alerts error: ${err.message}`));
  }, 30 * 60 * 1000);

  process.on("SIGTERM", () => {
    log("SIGTERM — shutting down...");
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
    // Fetch recent BB chats, find messages from unknowns, alert for each
    console.log("Scanning recent BB messages for unknown contacts...");
    let allChats = [];
    let offset = 0;
    while (true) {
      const data  = await bbPost("chat/query", { limit: 300, offset, sort: "lastmessage", withLastMessage: false });
      const batch = extractBBList(data);
      if (!batch.length) break;
      allChats.push(...batch);
      if (batch.length < 300) break;
      offset += 300;
    }
    console.log(`Scanned ${allChats.length} chats`);

    // Look at direct (non-group) chats only — iMessage;-; pattern
    const directChats = allChats.filter(c =>
      typeof c.guid === "string" && c.guid.startsWith("iMessage;-;+")
    );

    let found = 0;
    for (const chat of directChats) {
      const phone = chat.guid.replace("iMessage;-;", "");
      const norm  = normalizePhone(phone);
      if (isAllowed(norm) || isDenied(norm)) continue;

      // Fetch most recent message from this chat
      let lastMsg = "(no recent message)";
      try {
        const data = await bbRequest(`chat/${encodeURIComponent(chat.guid)}/message`, { limit: 1, sort: "DESC" });
        const msgs = extractBBList(data);
        if (msgs.length) lastMsg = msgs[0].text || lastMsg;
      } catch {}

      console.log(`  Alerting for unknown: ${phone}`);
      await postUnknownAlert(phone, lastMsg, chat.displayName || phone, { source: "unknown" });
      found++;
      await new Promise(r => setTimeout(r, 500)); // small delay between posts
    }
    console.log(`Done — fired ${found} alert(s)`);
    return;
  }

  // Single phone mode: ghost retrigger +15551234567
  const phone = args.find(a => a.startsWith("+") || /^\d{10,}$/.test(a));
  if (!phone) {
    console.error("Usage: ghost retrigger <+phone>  OR  ghost retrigger --scan");
    process.exit(1);
  }

  const norm = normalizePhone(phone);
  if (isAllowed(norm)) {
    console.log(`+${norm} is already in the allowlist — no alert needed.`);
    return;
  }
  if (isDenied(norm)) {
    console.log(`+${norm} is in the denylist — remove it first if you want to re-evaluate.`);
    return;
  }

  // Fetch their most recent message for context
  let lastMsg = "(no recent message)";
  try {
    const chatGuid = `iMessage;-;+${norm}`;
    const data = await bbRequest(`chat/${encodeURIComponent(chatGuid)}/message`, { limit: 1, sort: "DESC" });
    const msgs = extractBBList(data);
    if (msgs.length) lastMsg = msgs[0].text || lastMsg;
  } catch {}

  console.log(`Firing unknown-contact alert for +${norm}...`);
  await postUnknownAlert(`+${norm}`, lastMsg, `+${norm}`, { source: "unknown" });
  console.log("Alert posted to Discord.");
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
  case "react":
    doReactionCheck()
      .then(() => process.exit(0))
      .catch(err => { console.error(err.message); process.exit(1); });
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
    console.log("Usage: ghost [serve|react|learn|status|pause|resume|schedule|retrigger]");
    console.log("");
    console.log("  serve                  webhook server + embedded reaction loop");
    console.log("  react                  one-shot reaction check");
    console.log("  learn [--all]          build contact memories + voice profile   (Phase 1)");
    console.log("  learn --contact <num>  learn one contact");
    console.log("  status                 show server/memory/draft state");
    console.log("  pause [--hours N]      pause ghost");
    console.log("  resume                 resume ghost");
    console.log("  schedule               print nightly learn cron line            (Phase 5)");
    console.log("  retrigger <+phone>     re-fire an unknown-contact alert (fresh Approve/Deny buttons)");
    console.log("  retrigger --scan       scan recent BB messages and alert for any unknowns");
    process.exit(1);
}
} // end require.main === module guard

// ── Test exports (only when required as a module, not run directly) ──────────
if (require.main !== module) {
  module.exports = {
    normalizePhone,
    isFromKlein,
    requiresReply,
    extractBBList,
    isQuietHours,
    loadAllowlist,
    loadContactsMap,
    isDenied,
    isLikelySpam,
    isAllowed,
    isGroupChatGuid,
    findChatsForPhone,
    findChatGuidForPhone,
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
    loadButtonRegistry,
    saveButtonRegistry,
    BUTTON_REGISTRY_FILE,
    // Integration test exports
    createServer,
    runPreflight,
    logFeedback,
    doReactionCheck,
    sweepStaleUnknownAlerts,
    pendingUnknownAlerts,
    pendingMessages,
    loadPendingDrafts,
    savePendingDrafts,
    checkAndDraft,
    DATA_DIR,
    GHOST_DIR,
    GHOST_CHANNEL,
    DRAFT_DELAY_MS,
    KLEIN_DISCORD_USER_ID,
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
    OUTBOUND_BACKOFF_FILE,
    OUTBOUND_RATE_FILE,
    BACKOFF_BASE_MS,
    BACKOFF_MAX_LEVEL,
    sendLocks,
    // Audit-fix exports
    addToAllowlist,
    addToDenylist,
    dmPhoneFromChatGuid,
    bbSendMessage,
    executeSend,
    discordPost,
    tryGeminiCli,
    buildVoiceProfile,
    isAuthorizedRequest,
    VOICE_PROFILE_FILE,
    MAX_BODY_BYTES,
  };
}
