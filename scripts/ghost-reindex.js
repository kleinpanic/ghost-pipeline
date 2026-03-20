#!/usr/bin/env node
/**
 * ghost-reindex.js — Two-phase rate-limited reindex of BB history into ghost-memories.db
 *
 * PHASE 1 — Ingest: Pull messages from BB, INSERT OR IGNORE into DB (no API calls, fast).
 * PHASE 2 — Embed:  Find all rows with NULL embedding, call Gemini sequentially with full
 *                   rate limiting. Safe to interrupt and re-run — already-embedded rows skipped.
 *
 * Rate limits (gemini-embedding-001 free tier, from ai.google.dev):
 *   Reported limit : ~100 RPM
 *   Our target     : 40 RPM  (1 req per 1500ms — comfortable safety margin)
 *   Daily budget   : 800 req/run (leaves ~200/day for live ghost.js)
 *
 * 429 handling: exponential backoff starting at 60s, doubling each retry, max 5min.
 *               After 5 consecutive 429s with no progress → stop cleanly, re-run to continue.
 *
 * Usage:
 *   node scripts/ghost-reindex.js                     # all contacts, full run
 *   node scripts/ghost-reindex.js --contact +15551234567
 *   node scripts/ghost-reindex.js --embed-only        # skip ingest phase
 *   node scripts/ghost-reindex.js --limit 200         # max msgs per contact (default 500)
 */
"use strict";

const path        = require("path");
const https       = require("https");
const fs          = require("fs");
const { spawnSync } = require("child_process");

// ─── Load ghost module ─────────────────────────────────────────────────────
const ghost = require("../src/ghost");

const HOME          = process.env.HOME || require("os").homedir();
const DATA_DIR      = path.join(HOME, ".openclaw", "data");
const DB_PATH       = path.join(DATA_DIR, "ghost-memories.db");
const CONTACTS_FILE = path.join(HOME, ".openclaw", "workspace-ghost", "governance", "CONTACTS.md");

// ─── Rate limit constants (gemini-embedding-001 free tier) ─────────────────
const INTER_REQUEST_MS = 1500;   // 1.5s between requests = 40 RPM (well under ~100 RPM limit)
const DAILY_BUDGET     = 800;    // max embeds this run (leaves ~200/day for live ghost.js)
const MAX_429_RETRIES  = 5;      // consecutive 429s before giving up
const BACKOFF_BASE_MS  = 60000;  // 60s initial backoff on 429
const BACKOFF_MAX_MS   = 300000; // 5min cap on backoff
const MAX_FAIL_STREAK  = 5;      // consecutive non-429 failures before stopping

// ─── Gemini API key ────────────────────────────────────────────────────────
const GEMINI_API_KEY = (() => {
  const envFile = path.join(HOME, ".openclaw", ".env");
  try {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^GEMINI_API_KEY\s*=\s*(.+)/);
      if (m) return m[1].trim();
    }
  } catch {}
  return process.env.GEMINI_API_KEY || "";
})();

// ─── Helpers ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function openDb() {
  // Open without sqlite-vec extension — we only need basic INSERT/UPDATE here
  const Database = require("better-sqlite3");
  return new Database(DB_PATH);
}

function mcporterSync(tool, params) {
  const r = spawnSync("mcporter",
    ["call", `bluebubbles.${tool}`, "--args", JSON.stringify(params)],
    { encoding: "utf8", timeout: 30000, env: process.env }
  );
  if (r.error) throw r.error;
  return r.stdout || "";
}

// ─── Single embed call (returns status code for 429 detection) ─────────────
function embedOnce(text) {
  return new Promise((resolve) => {
    if (!GEMINI_API_KEY) { resolve({ ok: false, code: 0, error: "no API key" }); return; }
    const body = JSON.stringify({
      model:   "models/gemini-embedding-001",
      content: { parts: [{ text }] },
    });
    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      path:     `/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        if (res.statusCode === 429) {
          resolve({ ok: false, code: 429 });
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const values = parsed?.embedding?.values;
          if (Array.isArray(values) && values.length === 3072) {
            resolve({ ok: true, vec: Buffer.from(new Float32Array(values).buffer) });
          } else {
            resolve({ ok: false, code: res.statusCode,
              error: `unexpected response (${res.statusCode}): ${data.slice(0, 120)}` });
          }
        } catch (e) {
          resolve({ ok: false, code: res.statusCode, error: e.message });
        }
      });
    });
    req.on("error", (e) => resolve({ ok: false, code: 0, error: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, code: 0, error: "timeout (15s)" }); });
    req.write(body);
    req.end();
  });
}

// ─── Embed with 429 backoff + fail-streak detection ────────────────────────
async function embedWithBackoff(text, stats) {
  if (stats.budget <= 0) throw new Error(`Daily budget of ${DAILY_BUDGET} exhausted`);

  let backoffMs  = BACKOFF_BASE_MS;
  let retries429 = 0;

  while (retries429 < MAX_429_RETRIES) {
    const result = await embedOnce(text);

    if (result.ok) {
      stats.budget--;
      stats.failStreak = 0;
      return result.vec;
    }

    if (result.code === 429) {
      retries429++;
      console.log(`  ⏳ 429 rate limited — backoff ${Math.round(backoffMs / 1000)}s (retry ${retries429}/${MAX_429_RETRIES})`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      continue;
    }

    // Non-retryable error
    console.log(`  ⚠️  Embed error (skipping): ${result.error}`);
    stats.failStreak++;
    if (stats.failStreak >= MAX_FAIL_STREAK) {
      throw new Error(`${MAX_FAIL_STREAK} consecutive non-429 failures — check API key or network`);
    }
    return null; // skip this message, move on
  }

  // Exhausted all 429 retries
  throw new Error(`429 rate limit: ${MAX_429_RETRIES} retries exhausted — re-run after quota resets (midnight PT)`);
}

// ─── Phase 1: Ingest messages from BB (no API calls) ───────────────────────
async function phaseIngest(contacts) {
  console.log("📥 Phase 1 — Ingest\n");

  // Fetch all chats once
  let allChats = [], offset = 0;
  process.stdout.write("  Fetching chats from BB...");
  while (true) {
    const batch = ghost.extractBBList(mcporterSync("bb_list_chats", { limit: 300, offset }));
    if (!batch.length) break;
    allChats.push(...batch);
    if (batch.length < 300) break;
    offset += 300;
  }
  console.log(` ${allChats.length} chats\n`);

  let totalNew = 0;

  for (const contact of contacts) {
    const norm  = ghost.normalizePhone(contact.phone);
    const chats = ghost.findChatsForPhone(contact.phone, allChats);
    if (!chats.length) { console.log(`  ${contact.alias}: no chats — skip`); continue; }

    let messages = [];
    for (const chat of chats) {
      try {
        const msgs = ghost.extractBBList(
          mcporterSync("bb_get_chat_messages", { chat_guid: chat.guid, limit: msgLimit, sort: "DESC" })
        );
        if (msgs.length) { messages = msgs; break; }
      } catch {}
    }
    if (!messages.length) { console.log(`  ${contact.alias}: 0 messages — skip`); continue; }

    const db     = openDb();
    const insert = db.prepare("INSERT OR IGNORE INTO contact_memories (phone, ts, role, text) VALUES (?, ?, ?, ?)");
    const batch  = db.transaction((msgs) => {
      let n = 0;
      for (const m of msgs) {
        if (!m.text?.trim()) continue;
        const info = insert.run(
          norm,
          m.dateCreated || Date.now(),
          ghost.isFromKlein(m) ? "me" : "them",
          m.text.trim()
        );
        if (info.changes) n++;
      }
      return n;
    });
    const inserted = batch(messages);
    db.close();

    console.log(`  ${contact.alias} (+${norm}): ${messages.length} fetched, ${inserted} new rows`);
    totalNew += inserted;
  }

  console.log(`\n  ✅ Ingest done — ${totalNew} new rows added\n`);
}

// ─── Phase 2: Embed rows with NULL embedding ────────────────────────────────
async function phaseEmbed(contacts) {
  const phones       = contacts.map(c => ghost.normalizePhone(c.phone));
  const placeholders = phones.map(() => "?").join(",");

  const db   = openDb();
  const rows = db.prepare(
    `SELECT id, phone, ts, text FROM contact_memories
     WHERE embedding IS NULL AND phone IN (${placeholders})
     ORDER BY phone, ts ASC`
  ).all(...phones);
  db.close();

  const total = rows.length;
  if (!total) {
    console.log("🧠 Phase 2 — Embed\n");
    console.log("  ✅ All messages already embedded — nothing to do\n");
    return;
  }

  const etaMin = Math.ceil(total * INTER_REQUEST_MS / 60000);
  console.log("🧠 Phase 2 — Embed\n");
  console.log(`  Rows to embed  : ${total}`);
  console.log(`  Rate target    : ${Math.round(60000 / INTER_REQUEST_MS)} RPM (1 req per ${INTER_REQUEST_MS}ms)`);
  console.log(`  Daily budget   : ${DAILY_BUDGET} (${DAILY_BUDGET - total < 0 ? "⚠️  will hit cap mid-run" : "✅ within budget"})`);
  console.log(`  ETA            : ~${etaMin} min\n`);
  console.log("  Re-run to continue if interrupted — already-embedded rows are skipped.\n");

  const stats = { budget: DAILY_BUDGET, failStreak: 0 };
  const updateStmt = (db) => db.prepare("UPDATE contact_memories SET embedding = ? WHERE id = ?");
  let done = 0, skipped = 0;

  for (const row of rows) {
    let vec;
    try {
      vec = await embedWithBackoff(row.text, stats);
    } catch (err) {
      console.log(`\n  ⛔ Stopping: ${err.message}`);
      console.log(`  Progress: ${done} embedded, ${skipped} skipped, ${total - done - skipped} remaining`);
      console.log("  Re-run with --embed-only to resume.\n");
      return;
    }

    if (vec) {
      const db2 = openDb();
      updateStmt(db2).run(vec, row.id);
      db2.close();
      done++;
    } else {
      skipped++;
    }

    if ((done + skipped) % 25 === 0 && (done + skipped) > 0) {
      const pct      = Math.round((done + skipped) / total * 100);
      const remaining = total - done - skipped;
      const etaLeft  = Math.ceil(remaining * INTER_REQUEST_MS / 60000);
      console.log(`  [${pct}%] ${done} embedded, ${skipped} skipped, ~${etaLeft}min left, ${stats.budget} budget remaining`);
    }

    // Throttle — wait between requests
    await sleep(INTER_REQUEST_MS);
  }

  console.log(`\n  ✅ Embed done — ${done} embedded, ${skipped} skipped`);
  console.log(`  Budget used: ${DAILY_BUDGET - stats.budget} / ${DAILY_BUDGET}\n`);
}

// ─── Args ──────────────────────────────────────────────────────────────────
const argv       = process.argv.slice(2);
const targetPhone = argv.includes("--contact")    ? argv[argv.indexOf("--contact") + 1]  : null;
const embedOnly   = argv.includes("--embed-only");
const msgLimit    = argv.includes("--limit")
  ? parseInt(argv[argv.indexOf("--limit") + 1])
  : 500;

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  if (!GEMINI_API_KEY) {
    console.error("❌ GEMINI_API_KEY not set in ~/.openclaw/.env");
    process.exit(1);
  }

  const allContacts = ghost.loadAllowlist ? ghost.loadAllowlist() : [];
  if (!allContacts.length) {
    console.error("❌ No contacts found in governance/CONTACTS.md");
    process.exit(1);
  }

  const contacts = targetPhone
    ? allContacts.filter(c => ghost.normalizePhone(c.phone) === ghost.normalizePhone(targetPhone))
    : allContacts;

  if (!contacts.length) {
    console.error(`❌ Contact ${targetPhone} not in allowlist`);
    process.exit(1);
  }

  console.log("\n🗄  Ghost Reindex (Rate-Limited)");
  console.log(`   Contact   : ${targetPhone || "all (${contacts.length})"}`);
  console.log(`   Limit     : ${msgLimit} msgs/contact`);
  console.log(`   Mode      : ${embedOnly ? "embed-only (skip ingest)" : "full (ingest + embed)"}\n`);

  if (!embedOnly) await phaseIngest(contacts);
  await phaseEmbed(contacts);

  // Final summary
  const db   = openDb();
  const stat = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN embedding IS NULL THEN 1 ELSE 0 END) as missing FROM contact_memories").get();
  db.close();
  console.log(`📊 DB: ${stat.total} total rows, ${stat.missing} still missing embeddings`);
  if (stat.missing > 0) {
    console.log(`   Run with --embed-only to finish the remaining ${stat.missing}\n`);
  } else {
    console.log("   All rows fully embedded ✅\n");
  }
  process.exit(0);
})().catch(err => {
  console.error(`\n❌ Fatal: ${err.message}`);
  process.exit(1);
});
