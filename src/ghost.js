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

// Embeddings + memories DB
const GHOST_MEMORIES_DB   = path.join(DATA_DIR, "ghost-memories.db");
const GHOST_CONV_STATE_FILE = path.join(DATA_DIR, "ghost-conv-state.json");

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

// ── Content safety patterns (checked on every draft before returning) ────
const NEVER_SAY = [
  /\bn[\-*]+w+er\b/i,
  /\bf[\-*]+ck\s+you\b/i,
  /\bkill\s+yourself\b/i,
  /\byou\s+(should\s+)?die\b/i,
  /\bi\s+(will\s+)?find\s+you\b/i,
  /\byour\s+(address|location|home)/i,
  /\bsocial\s+security\b/i,
  /\bcredit\s+card\b/i,
  /\bpassword\b/i,
  /\bsend\s+me\s+money\b/i,
  /\bwire\s+transfer\b/i,
];

// Secrets
const BB_PASSWORD        = readSecret(path.join(HOME, ".config", "bluebubbles", "password"));
const OPENROUTER_API_KEY = readSecret(path.join(HOME, ".config", "openrouter", "api-key"));
const DISCORD_BOT_TOKEN  = readSecret(path.join(HOME, ".config", "discord", "bot-token"));

// GEMINI_API_KEY — loaded from env or .env file
function loadEnvFile(filename) {
  try {
    const envPath = path.isAbsolute(filename) ? filename : path.join(HOME, ".openclaw", filename);
    const raw = fs.readFileSync(envPath, "utf8");
    const result = {};
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m) result[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return result;
  } catch { return {}; }
}
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || loadEnvFile(".env").GEMINI_API_KEY || "";

// Network
const PORT    = 18790;
const BB_HOST = process.env.BB_HOST || "10.0.0.196";  // BB server lives on Collins, not localhost
const BB_PORT = parseInt(process.env.BB_PORT || "1234");

// Discord
const GHOST_CHANNEL = "1474492563418517515";

// Identity
const OWNER_PHONE_NORMALIZED = "12673479614";
const KLEIN_DISCORD_USER_ID  = process.env.KLEIN_DISCORD_USER_ID || "";

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
- DO NOT use: "bruh", "lmfao", "nigga", heavy slang, or crude phrases.
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
const SPARK_BASE_URL = process.env.SPARK_BASE_URL || "http://10.99.1.1:18080/v1";
const SPARK_API_KEY  = readSecret(path.join(HOME, ".openclaw", ".spark-key")) ||
                       "610b70253998918445408763682298af4c1f492fae39c9289f938f55f7c47310";
const SPARK_MODEL_FAST   = "openai/gpt-oss-20b";
const SPARK_MODEL_STRONG = "openai/gpt-oss-120b";

// ── Phase 4: OpenClaw Ghost Agent  (uses full model chain + workspace context)
const OC_GATEWAY_TOKEN = readSecret(path.join(HOME, ".openclaw", ".gateway-token")) ||
                         "c8715f1295db97dfb8970b2189df2a0a0871a251d2e6cef0";

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
 * - 'active' mode (≥3 ghost sends): 1.5–3.5 min
 * - 'stranger' mode: 3.5–7.5 min
 */
function getCooldownMs(phone) {
  const n     = normalizePhone(phone);
  const state = loadConvState();
  const entry = state[n];
  if (entry && entry.mode === "active") {
    // Check if active mode timed out (5min silence since last ghost send)
    const lastSend = entry.lastGhostSendAt ? new Date(entry.lastGhostSendAt).getTime() : 0;
    if (Date.now() - lastSend > ACTIVE_TIMEOUT_MS) {
      // timed out — treat as stranger
      return randomCooldown(COOLDOWN_STRANGER_MIN_MS, COOLDOWN_STRANGER_MAX_MS);
    }
    return randomCooldown(COOLDOWN_ACTIVE_MIN_MS, COOLDOWN_ACTIVE_MAX_MS);
  }
  return randomCooldown(COOLDOWN_STRANGER_MIN_MS, COOLDOWN_STRANGER_MAX_MS);
}

/** Called when ghost successfully sends to a contact. */
function onGhostSend(phone) {
  const n     = normalizePhone(phone);
  const state = loadConvState();
  const entry = state[n] || { mode: "stranger", exchangeCount: 0 };
  entry.exchangeCount   = (entry.exchangeCount || 0) + 1;
  entry.lastGhostSendAt = new Date().toISOString();
  if (entry.exchangeCount >= ACTIVE_EXCHANGE_THRESHOLD) entry.mode = "active";
  state[n] = entry;
  saveConvState(state);
}

/** Called when a contact sends us a message. */
function onContactMessage(phone) {
  const n     = normalizePhone(phone);
  const state = loadConvState();
  const entry = state[n] || { mode: "stranger", exchangeCount: 0 };
  entry.lastContactMsgAt = new Date().toISOString();
  // If active but ghost has been silent > ACTIVE_TIMEOUT_MS, reset to stranger
  if (entry.mode === "active") {
    const lastSend = entry.lastGhostSendAt ? new Date(entry.lastGhostSendAt).getTime() : 0;
    if (Date.now() - lastSend > ACTIVE_TIMEOUT_MS) {
      entry.mode          = "stranger";
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
  { re: /ignore\s+(all\s+)?previous\s+instructions/i,                label: "ignore previous instructions" },
  { re: /you\s+are\s+(now\s+)?(an?\s+)?(?:ai|bot|assistant|language model|llm)/i, label: "you are an AI" },
  { re: /reveal\s+(your\s+)?(system\s+)?prompt/i,                    label: "reveal prompt" },
  { re: /repeat\s+(back\s+)?(everything|your instructions|your prompt)/i, label: "repeat instructions" },
  { re: /disregard\s+(your\s+)?(previous|prior|all)/i,               label: "disregard previous" },
  { re: /new\s+instructions?:/i,                                     label: "new instructions" },
  { re: /\[system\]/i,                                               label: "[system] tag" },
  { re: /as\s+an?\s+(ai|language model|llm)/i,                       label: "as an AI" },
  { re: /your\s+true\s+(identity|purpose|role)/i,                    label: "true identity" },
  { re: /print\s+(your\s+)?(instructions?|prompt|rules)/i,           label: "print instructions" },
  { re: /what\s+(are|were)\s+your\s+(instructions?|rules|guidelines)/i, label: "what are your instructions" },
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

function passesContentSafety(draftText) {
  if (!draftText) return true;
  return !NEVER_SAY.some(pattern => pattern.test(draftText));
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
          // 5-field format: rest[0]=category, rest[1]=label, rest[2+]=notes
          category   = rest[0].toLowerCase();
          labelField = rest[1] || "";
        } else {
          // Legacy 4-field: rest[0]=label, rest[1+]=notes
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

function addToAllowlist(phone, name, { source = "manual", emails = [], birthday = null, notes = "" } = {}) {
  const n         = normalizePhone(phone);
  const displayName = name || "Unknown";
  const sourceNote = source === "apple_contacts"
    ? `From Apple Contacts ${new Date().toISOString().slice(0, 10)}`
    : `Added ${new Date().toISOString().slice(0, 10)}`;
  const extraNotes = [notes, birthday ? `birthday ${birthday}` : ""].filter(Boolean).join("; ");
  const line = `- ${displayName} | +${n} | ask | Friend | ${sourceNote}${extraNotes ? " | " + extraNotes : ""}\n`;
  const raw    = readFileSafe(CONTACTS_FILE);
  const marker = "<!-- CONTACT_ALLOWLIST_END -->";
  writeFileSafe(CONTACTS_FILE, raw.replace(marker, line + marker));
  log(`Added +${n} to allowlist as "${displayName}" (source: ${source})`);
}

function addToDenylist(phone) {
  const n    = normalizePhone(phone);
  const list = loadJson(DENYLIST_FILE, []);
  if (!list.includes(n)) { list.push(n); saveJson(DENYLIST_FILE, list); }
  log(`Added +${n} to denylist`);
}

/**
 * Returns false for messages that obviously don't need a reply:
 * one-word acks, emoji-only, conversation closers, reactions.
 */
function requiresReply(messageText) {
  if (!messageText || !messageText.trim()) return false;
  const raw = messageText.trim();
  const t   = raw.toLowerCase().replace(/[!?.]+$/, "").trim(); // strip trailing punctuation for matching

  // ── Emoji-only ──────────────────────────────────────────────────────────
  if (/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\s]+$/u.test(raw)) return false;

  // ── iMessage tapback reactions ───────────────────────────────────────────
  if (/^(liked|loved|disliked|emphasized|questioned|laughed at) ".{0,80}"$/.test(t)) return false;

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

  return false;
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
    let stdout = "", stderr = "";
    const proc = spawn(cmd, args, { env: { ...process.env, HOME } });
    proc.stdout?.on("data", d => { stdout += d.toString(); });
    proc.stderr?.on("data", d => { stderr += d.toString(); });
    proc.on("close", code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(0, 200)}`));
    });
    proc.on("error", reject);
    if (timeout) {
      setTimeout(() => { try { proc.kill(); } catch {} reject(new Error(`${cmd} timed out`)); }, timeout);
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

/** Try OpenRouter with a specific model. Returns text or null. */
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
            resolve(text);
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

// ── OR model probe list (key → full OR model id) ─────────────────────────
const OR_MODEL_PROBE_LIST = [
  { key: "claude-haiku",  model: "anthropic/claude-haiku-4.5" },
  { key: "gemini-flash",  model: "google/gemini-3-flash-preview" },
  { key: "gemma-27b",     model: "google/gemma-3-27b-it:free" },
  { key: "llama-70b",     model: "meta-llama/llama-3.3-70b-instruct:free" },
  { key: "mistral-small", model: "mistralai/mistral-small-3.1-24b-instruct:free" },
];

/**
 * Phase 0.5 — Model Preflight
 * Probes which models are usable RIGHT NOW and returns them in priority order:
 *   ghost-agent → spark-fast → [OR models not on cooldown] → spark-strong
 *
 * Checks:
 * - Ghost agent session: must be active within last 30 min (via OC gateway sessions_list)
 * - Spark: uses checkSparkAvailable() (5-min cache)
 * - OR models: skipped if OR_COOLDOWN_MAP has a future cooldownUntilMs entry
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

  // 2. Spark fast
  const sparkOk = await checkSparkAvailable();
  if (sparkOk) available.push("spark-fast");

  // 3. OR models — skip any currently cooling
  const now = Date.now();
  for (const { key, model } of OR_MODEL_PROBE_LIST) {
    const coolUntil = OR_COOLDOWN_MAP.get(model);
    if (!coolUntil || now > coolUntil) {
      available.push(key);
    } else {
      log(`probeAvailableModels: ${key} cooling (${Math.ceil((coolUntil - now) / 1000)}s remaining)`);
    }
  }

  // 4. Spark strong — last resort
  if (sparkOk) available.push("spark-strong");

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

/**
 * Call the ghost agent session via OC gateway /tools/invoke HTTPS endpoint.
 * gateway.tools.allow includes "sessions_send" so this is permitted.
 * Returns { text, model } or null on timeout/failure.
 */
async function tryGhostAgentSession(contactName, messageText, systemPrompt, userContent, timeoutMs = 25000) {
  if (!OC_GATEWAY_TOKEN) { log("Ghost agent: no gateway token — skipping"); return null; }

  const prompt = [
    `You are drafting a reply for Klein. Use his texting style from your SOUL.md.`,
    `Contact: ${contactName}`,
    systemPrompt ? `\nContext:\n${systemPrompt}` : "",
    `\n${userContent}`,
    `\nOutput ONLY the reply text — nothing else. Max 1-2 short texts.`,
  ].join("\n");

  return new Promise((resolve) => {
    const body = JSON.stringify({
      tool:       "sessions_send",
      args: {
        sessionKey:     GHOST_AGENT_SESSION_KEY,
        message:        prompt,
        timeoutSeconds: Math.floor(timeoutMs / 1000) - 2,
      },
    });

    const req = https.request({
      hostname: "127.0.0.1",
      port:     OC_GATEWAY_PORT,
      path:     "/tools/invoke",
      method:   "POST",
      rejectUnauthorized: false,   // self-signed local cert
      headers: {
        "Authorization": `Bearer ${OC_GATEWAY_TOKEN}`,
        "Content-Type":  "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          // Extract text from OC tool result envelope
          const inner = parsed?.result?.details ?? parsed?.result;
          // sessions_send with timeout returns details.reply as the agent's response
          const rawText = (typeof inner === "string" ? inner
            : inner?.reply ?? inner?.text ?? inner?.message ?? inner?.content?.[0]?.text ?? "");
          // Strip any JSON wrapper the agent might have added
          let text = rawText.trim();
          try {
            const j = JSON.parse(text);
            text = j.text ?? j.reply ?? j.message ?? text;
          } catch {}
          if (text && !parsed?.error) {
            log(`Ghost agent session draft ok: "${text.slice(0,40)}"`);
            resolve({ text: text.trim(), model: "ghost-agent" });
          } else {
            log(`Ghost agent session: empty/error response — ${JSON.stringify(parsed).slice(0,100)}`);
            resolve(null);
          }
        } catch (e) {
          log(`Ghost agent session parse error: ${e.message}`);
          resolve(null);
        }
      });
    });

    req.setTimeout(timeoutMs, () => { req.destroy(); log("Ghost agent session: timeout"); resolve(null); });
    req.on("error", (e) => { log(`Ghost agent session error: ${e.message}`); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Post a message via the OpenClaw gateway tools/invoke endpoint.
 * Used for posting draft buttons so OC registers the components (prevents 30-min expiry).
 * Returns the parsed JSON response or null on failure.
 */
function ocGatewayPost(tool, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!OC_GATEWAY_TOKEN) { resolve(null); return; }
    const body = JSON.stringify({ tool, args });
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
    if (!passesContentSafety(trimmed)) {
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
      case "claude-haiku": {
        log("Draft: OR claude-haiku-4.5...");
        const t = await tryOpenRouter("anthropic/claude-haiku-4.5", systemPrompt, userContent, 25000);
        const r = safeReturn(t, "claude-haiku");
        if (r) return r;
        break;
      }
      case "gemini-flash": {
        log("Draft: OR gemini-flash...");
        const t = await tryOpenRouter("google/gemini-3-flash-preview", systemPrompt, userContent, 25000);
        const r = safeReturn(t, "gemini-flash");
        if (r) return r;
        break;
      }
      case "gemma-27b": {
        log("Draft: OR gemma-3-27b-it:free...");
        const t = await tryOpenRouter("google/gemma-3-27b-it:free", systemPrompt, userContent, 20000);
        const r = safeReturn(t, "gemma-27b");
        if (r) return r;
        break;
      }
      case "llama-70b": {
        log("Draft: OR llama-3.3-70b-instruct:free...");
        const t = await tryOpenRouter("meta-llama/llama-3.3-70b-instruct:free", systemPrompt, userContent, 20000);
        const r = safeReturn(t, "llama-70b");
        if (r) return r;
        break;
      }
      case "mistral-small": {
        log("Draft: OR mistral-small-3.1-24b-instruct:free...");
        const t = await tryOpenRouter("mistralai/mistral-small-3.1-24b-instruct:free", systemPrompt, userContent, 20000);
        const r = safeReturn(t, "mistral-small");
        if (r) return r;
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

async function buildSystemPrompt(contactName, contactPhone, triggerMessage = "") {
  const soul    = readFileSafe(SOUL_FILE).trim();
  const voice   = readFileSafe(VOICE_PROFILE_FILE).trim();
  const contact = loadContactMemory(contactPhone);

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

  return `Recent conversation (oldest → newest):\n${history || "(no prior messages)"}\n\nLatest message from ${contactName}:\n"${messageText}"\n\nReply as Klein:`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  DISCORD
// ═══════════════════════════════════════════════════════════════════════════

async function discordPost(channelId, payload) {
  try {
    const stdout = await spawnAsync("curl", [
      "-s", "-X", "POST",
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      "-H", `Authorization: Bot ${DISCORD_BOT_TOKEN}`,
      "-H", "Content-Type: application/json",
      "-d", JSON.stringify(payload),
    ], { timeout: 10000 });
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
      "-H", `Authorization: Bot ${DISCORD_BOT_TOKEN}`,
    ], { timeout: 8000 });
  } catch (err) {
    log(`Discord delete error: ${err.message}`);
  }
}

// In-memory map of unanswered unknown-contact alerts: phone → { messageId, postedAt, phone, messageText, contactName, source, enrichment }
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

  const history = (contextMessages || [])
    .filter(m => m.text?.trim())
    .slice(0, 5).reverse()
    .map(m => `> ${(m.isFromMe === true || m.from === "me") ? "Klein" : contactName}: ${m.text.trim().slice(0, 120)}`)
    .join("\n");

  let content = `📱 **${safeName}** (${phone})\n`;
  if (history) content += `\n${history}\n`;
  content += `\n**Them:** ${messageText || "(no text)"}\n`;

  const isSafetyBlocked = draftResult && draftResult.model === "safety-blocked";
  const hasUsableDraft  = draftResult && draftResult.text && !isSafetyBlocked;

  if (hasUsableDraft) {
    const cooldownMin = Math.round((autoSendMs || AUTO_SEND_WINDOW_MS) / 60000 * 10) / 10;
    content += `\n📝 **Draft** · via ${draftResult.model}:\n> ${draftResult.text}\n\n_Auto-sends in ${cooldownMin} min — ✅ send now · ❌ cancel_`;
  } else if (isSafetyBlocked) {
    content += `\n⚠️ All draft tiers failed content safety — reply manually.`;
  } else {
    content += `\n⚠️ Draft generation failed — reply manually.`;
  }

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
              { label: "✅ Send Now", style: "success" },
              { label: "❌ Cancel",   style: "danger"  },
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
            "-H", `Authorization: Bot ${DISCORD_BOT_TOKEN}`,
          ], { timeout: 8000 });
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
        log("postDraftToDiscord: OC gateway returned no messageId — falling back to discordPost");
      }
    } catch (err) {
      log(`postDraftToDiscord: OC gateway error (${err.message.slice(0, 80)}) — falling back`);
    }
  }

  // Fallback: raw Discord API (no-draft case, or if OC gateway failed)
  if (!messageId) {
    const result = await discordPost(GHOST_CHANNEL, {
      content,
      components: hasUsableDraft ? [{
        type: 1,
        components: [
          { type: 2, label: "✅ Send Now", style: 3, custom_id: `occomp:cid=GHOST_SEND:${draftId}`   },
          { type: 2, label: "❌ Cancel",   style: 4, custom_id: `occomp:cid=GHOST_CANCEL:${draftId}` },
        ],
      }] : [],
    });
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

async function postUnknownAlert(phone, messageText, contactName, { source = "unknown", enrichment = null } = {}) {
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

  const result = await discordPost(GHOST_CHANNEL, {
    content,
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: "Approve", custom_id: `occomp:cid=approve_${phone}` },
        { type: 2, style: 4, label: "Deny",    custom_id: `occomp:cid=deny_${phone}`    },
      ],
    }],
  });

  // Track so we can auto-repost before the 15-min Discord interaction token expires
  if (result?.id) {
    const nowTs = Date.now();
    pendingUnknownAlerts.set(phone, {
      messageId: result.id, postedAt: nowTs, alertedAt: nowTs,
      phone, messageText, contactName, source, enrichment,
    });
  }
}

// Refresh unknown-contact alerts before Discord's 15-min interaction token expires.
// Runs every 12 min; deletes stale message + reposts fresh one for any unanswered alert.
async function refreshUnknownAlerts() {
  if (!pendingUnknownAlerts.size) return;
  const REFRESH_MS = 12 * 60 * 1000; // 12 minutes
  const now = Date.now();
  // Snapshot stale entries BEFORE iterating — prevents re-visiting newly added entries
  const stale = [...pendingUnknownAlerts.entries()].filter(([, e]) => now - e.postedAt >= REFRESH_MS);
  for (const [phone, entry] of stale) {
    log(`Refreshing unknown-contact alert for +${normalizePhone(phone)} (token age >${REFRESH_MS / 60000}m)`);
    if (entry.messageId) await discordDelete(GHOST_CHANNEL, entry.messageId);
    pendingUnknownAlerts.delete(phone);
    // Repost fresh — re-adds to the map with a new postedAt
    await postUnknownAlert(phone, entry.messageText, entry.contactName, {
      source: entry.source, enrichment: entry.enrichment,
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
    log(`INJECTION ATTEMPT from ${contactName} (${normalized}): ${injCheck.reason}`);
    // Fire-and-forget Discord alert
    discordPost(GHOST_CHANNEL, {
      content: `⚠️ Prompt injection attempt from **${contactName}** (\`+${normalized}\`): ${injCheck.reason}`,
    }).catch(() => {});
    return { ok: false, reason: "injection" };
  }

  // 1. requiresReply — skip no-op acks, emoji-only, tapbacks, sensitive content
  if (!requiresReply(messageText)) {
    return { ok: false, reason: "no_reply_needed" };
  }

  // 2. isLikelySpam — keyword, url, short-code, rate-limit checks
  if (isLikelySpam(normalized, messageText)) {
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
  if (isGroupChatGuid(chatGuid, eventData)) {
    return { ok: false, reason: "group_chat" };
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

  return { ok: true, context: { messages, contactName, category } };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CORE DRAFT LOGIC
// ═══════════════════════════════════════════════════════════════════════════

// In-memory map: key (chatGuid|phone) → { contact, contactName, messageText, chatGuid, arrivedAt, timeoutId, contextMessages }
const pendingMessages = new Map();

async function checkAndDraft(key) {
  const entry = pendingMessages.get(key);
  if (!entry) return;
  let { contact, contactName, messageText, chatGuid, arrivedAt, autoSendMs } = entry;
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
  const systemPrompt = await buildSystemPrompt(contactName, contact, messageText);
  const userContent  = buildUserContent(contactName, messageText, contextMessages, arrivedAt);
  const historyLines = contextMessages
    .filter(m => m.text?.trim())
    .slice().reverse()
    .map(m => `${m.isFromMe ? "Klein" : contactName}: ${m.text.trim().slice(0, 150)}`)
    .join("\n");

  const draftResult = await generateDraft(systemPrompt, userContent, {
    contactName, contactPhone: contact, messageText, historyLines,
  });

  await postDraftToDiscord(draftResult, {
    chatGuid, contact, contactName, messageText, arrivedAt, contextMessages, autoSendMs,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  SEND HELPERS  (used by reaction check)
// ═══════════════════════════════════════════════════════════════════════════

async function bbSendMessage(chatGuid, message) {
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
    const sinceMs  = new Date(sinceIso).getTime() - 10000; // 10s buffer
    const argsJson = JSON.stringify({ chat_guid: chatGuid, limit: 10, sort: "DESC" });
    const stdout   = await spawnAsync("mcporter", [
      "call", "bluebubbles.bb_get_chat_messages", "--args", argsJson,
    ], { timeout: 15000 });
    const data     = tryParseJson(stdout);
    const messages = Array.isArray(data?.data) ? data.data : [];
    // BB direct HTTP uses isFromMe:true; mcporter/MCP uses from:"me"
    // normalizeTs: BB timestamps may be in seconds or ms; compare consistently in ms.
    return messages.some(m => (m.isFromMe === true || m.from === "me") && normalizeTs(m.dateCreated || 0) > sinceMs);
  } catch (err) {
    log(`kleinRepliedSince check failed (blocking send): ${err.message.slice(0, 80)}`);
    return true; // Can't verify → don't send
  }
}

async function executeSend(draft, reason) {
  const { contactName, chatGuid, draftText, postedAt, contact } = draft;

  if (!draftText) {
    log(`[${reason}] Empty draft for ${contactName} — skipping`);
    await discordPost(GHOST_CHANNEL, { content: `⚠️ Skipped **${contactName}**: draft was empty.` });
    return true; // remove from pending
  }

  // Quiet hours guard — applies to auto-send too, not just incoming messages
  if (reason === "auto-send" && isQuietHours(contact || chatGuid)) {
    log(`[${reason}] Quiet hours — holding draft for ${contactName} until morning`);
    // Keep in pending; it will fire when quiet hours lift
    return false;
  }

  // Late collision check
  if (postedAt && await kleinRepliedSince(chatGuid, postedAt)) {
    log(`[${reason}] Klein already replied to ${contactName} — skipping`);
    await discordPost(GHOST_CHANNEL, { content: `ℹ️ Skipped **${contactName}** — Klein already replied.` });
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
      let source = "manual";
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
            source = "apple_contacts";
            enrichOpts = {
              emails:   (cqData.emails || []).map(e => e.address).filter(Boolean),
              birthday: cqData.birthday || null,
            };
            log(`Approve enriched: +${normalizePhone(phone)} → "${name}" from Apple Contacts`);
          }
        }
      } catch {}
      addToAllowlist(phone, name, { source, ...enrichOpts });
    }
    for (const phone of denyQ) addToDenylist(phone);

    const now  = Date.now();
    const keep = [];

    for (const draft of drafts) {
      const { draftId, contactName, postedAt } = draft;
      const age     = now - new Date(postedAt || now).getTime();
      const expired = age > 24 * 60 * 60 * 1000;

      if (expired) { log(`Expired draft for ${contactName} — removing`); continue; }

      const action = actionMap[draftId];

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

      // No button action yet — will auto-send when AUTO_SEND_WINDOW_MS elapses

      keep.push(draft);
    }

    savePendingDrafts(keep);
    saveJson(BUTTON_ACTIONS_FILE, buttonActions.filter((_, i) => !consumed.has(i)));

  } finally {
    try { fs.closeSync(lockFd); fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════

function createServer() {
  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readBody = () => new Promise(resolve => {
      let b = "";
      req.on("data", c => { b += c; });
      req.on("end", () => resolve(b));
    });

    // GET /health
    if (req.method === "GET" && req.url === "/health") {
      return send(200, { ok: true, service: "ghost-v3", paused: isPaused(), pending: pendingMessages.size });
    }

    // GET /pending
    if (req.method === "GET" && req.url === "/pending") {
      const list = [...pendingMessages.entries()].map(([k, v]) => ({
        key: k, contactName: v.contactName,
        arrivedAt: new Date(v.arrivedAt).toISOString(),
        firesAt:   new Date(v.arrivedAt + DRAFT_DELAY_MS).toISOString(),
      }));
      return send(200, { ok: true, pending: list });
    }

    // POST /approve-contact
    if (req.method === "POST" && req.url === "/approve-contact") {
      try {
        const { phone, name } = JSON.parse(await readBody());
        if (!phone) throw new Error("phone required");
        addToAllowlist(phone, name || "Unknown");
        return send(200, { ok: true, action: "approved", phone });
      } catch (e) { return send(400, { ok: false, error: e.message }); }
    }

    // POST /deny-contact
    if (req.method === "POST" && req.url === "/deny-contact") {
      try {
        const { phone } = JSON.parse(await readBody());
        if (!phone) throw new Error("phone required");
        addToDenylist(phone);
        return send(200, { ok: true, action: "denied", phone });
      } catch (e) { return send(400, { ok: false, error: e.message }); }
    }

    // POST /action — triggered by pre-message hook for button clicks (both OC and legacy)
    if (req.method === "POST" && req.url === "/action") {
      try {
        const { draftId, action, userId } = JSON.parse(await readBody());
        if (!draftId || !action) return send(400, { ok: false, error: "draftId and action required" });
        // Optional userId check — enforced only when KLEIN_DISCORD_USER_ID env var is set
        if (KLEIN_DISCORD_USER_ID && userId && userId !== KLEIN_DISCORD_USER_ID) {
          return send(403, { ok: false, error: "unauthorized" });
        }
        const drafts   = loadPendingDrafts();
        const draftIdx = drafts.findIndex(d => d.draftId === draftId);
        if (draftIdx === -1) return send(404, { ok: false, error: "draft not found" });
        const draft = drafts[draftIdx];
        if (action === "cancel") {
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
    if (req.method === "POST" && req.url === "/bluebubbles/message-sent") {
      const body = await readBody();
      try {
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

        // Outgoing: Klein sent a message — cancel pending draft for this chat
        if (isFromMe || normalized === OWNER_PHONE_NORMALIZED) {
          const key = chatGuid || normalized;
          if (key && pendingMessages.has(key)) {
            clearTimeout(pendingMessages.get(key).timeoutId);
            pendingMessages.delete(key);
            log(`Klein replied to ${key} — cancelled pending draft`);
            return send(200, { ok: true, action: "draft_cancelled" });
          }
          return send(200, { ok: true, action: "outgoing_noop" });
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
        pendingMessages.set(key, { contact, contactName, messageText, chatGuid: chatGuid || key, arrivedAt, timeoutId, contextMessages: preflight.context.messages, autoSendMs: cooldownMs });
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
 * Returns true if the chatGuid (or event participants) indicate a group chat.
 * Direct messages use ";-;" separator across all protocols (iMessage, SMS, iMessageLite, RCS).
 * Group chats use ";+;" separator (e.g. "iMessage;+;chat123456789").
 */
function isGroupChatGuid(chatGuid, eventData = {}) {
  if (chatGuid) return chatGuid.includes(";+;");
  return Array.isArray(eventData.participants) && eventData.participants.length > 1;
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
    summary = await tryOpenRouter("google/gemma-3-27b-it:free", "", prompt, 30000);
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
  if (!profile) profile = await tryOpenRouter("google/gemma-3-27b-it:free", "", prompt, 30000);
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
  console.log(`✅ Ghost paused${until ? ` until ${until}` : " indefinitely"}.`);
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

function cmdServe() {
  // Clear any stale lock from a prior crash before starting reaction check loop
  try { fs.unlinkSync(LOCK_FILE); } catch {}
  purgeStaleDrafts();
  const server = createServer();
  server.listen(PORT, "0.0.0.0", () => {
    log(`Ghost v3 listening on :${PORT}`);
    log(`  Webhook : http://10.0.0.27:${PORT}/bluebubbles/message-sent`);
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
  };
}
