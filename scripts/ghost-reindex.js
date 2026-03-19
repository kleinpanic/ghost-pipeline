#!/usr/bin/env node
/**
 * ghost-reindex.js — Reindex all BB chat history into ghost-memories.db
 *
 * Usage:
 *   node scripts/ghost-reindex.js
 *   node scripts/ghost-reindex.js --provider google   (default)
 *   node scripts/ghost-reindex.js --contact +15551234567
 *
 * Options:
 *   --provider <name>   Embedding provider: 'google' (default) | 'stub'
 *   --contact <phone>   Reindex a single contact only
 *   --limit <n>         Max messages per contact (default: 500)
 */

"use strict";

const path   = require("path");
const { spawnSync } = require("child_process");

// ─── Load ghost module ────────────────────────────────────────────────────
const ghost = require("../src/ghost");

const HOME      = process.env.HOME || "/home/broklein";
const CONTACTS_FILE = path.join(HOME, ".openclaw", "workspace-ghost", "governance", "CONTACTS.md");

// ─── Parse CLI args ───────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const providerIdx = args.indexOf("--provider");
const contactIdx  = args.indexOf("--contact");
const limitIdx    = args.indexOf("--limit");

const provider     = providerIdx !== -1 ? args[providerIdx + 1] : "google";
const targetPhone  = contactIdx  !== -1 ? args[contactIdx + 1]  : null;
const msgLimit     = limitIdx    !== -1 ? parseInt(args[limitIdx + 1]) || 500 : 500;

console.log(`\n🗄  Ghost Reindex`);
console.log(`   Provider : ${provider}`);
console.log(`   Contact  : ${targetPhone || "all"}`);
console.log(`   Limit    : ${msgLimit} msgs/contact\n`);

// ─── Helper: call mcporter synchronously ────────────────────────────────
function mcporterSync(tool, argsObj) {
  const r = spawnSync("mcporter", [
    "call", `bluebubbles.${tool}`, "--args", JSON.stringify(argsObj),
  ], { encoding: "utf8", timeout: 60000, env: { ...process.env, HOME } });
  if (r.status !== 0) throw new Error(`mcporter ${tool}: ${r.stderr?.slice(0, 200)}`);
  return JSON.parse(r.stdout);
}

// ─── Main ────────────────────────────────────────────────────────────────
(async () => {
  // 1. Load contacts
  const allowlist = ghost.loadAllowlist();
  const contacts  = targetPhone
    ? allowlist.filter(c => ghost.normalizePhone(c.phone) === ghost.normalizePhone(targetPhone))
    : allowlist;

  if (!contacts.length) {
    console.error(`No contacts found${targetPhone ? ` matching ${targetPhone}` : ""}`);
    process.exit(1);
  }

  // 2. Fetch all chats from BB
  console.log("Fetching chats from BlueBubbles...");
  let allChats = [];
  let offset   = 0;
  while (true) {
    const data  = mcporterSync("bb_list_chats", { limit: 300, offset });
    const batch = ghost.extractBBList(data);
    if (!batch.length) break;
    allChats.push(...batch);
    if (batch.length < 300) break;
    offset += 300;
  }
  console.log(`  Found ${allChats.length} chats\n`);

  // 3. Reindex each contact
  let totalIndexed = 0;

  for (const contact of contacts) {
    const norm  = ghost.normalizePhone(contact.phone);
    const chats = ghost.findChatsForPhone(contact.phone, allChats);

    if (!chats.length) {
      console.log(`  ${contact.alias}: no chats found — skipping`);
      continue;
    }

    let messages = [];
    for (const chat of chats) {
      try {
        const data = mcporterSync("bb_get_chat_messages", { chat_guid: chat.guid, limit: msgLimit, sort: "DESC" });
        const msgs = ghost.extractBBList(data);
        if (msgs.length) { messages = msgs; break; }
      } catch (err) {
        console.log(`  ${contact.alias}: chat ${chat.guid.slice(0, 30)} fetch error — ${err.message.slice(0, 60)}`);
      }
    }

    if (!messages.length) {
      console.log(`  ${contact.alias}: 0 messages across ${chats.length} chat(s) — skipping`);
      continue;
    }

    console.log(`  ${contact.alias} (+${norm}): indexing ${messages.length} messages...`);
    let indexed = 0;
    for (const m of messages) {
      if (!m.text?.trim()) continue;
      const role = ghost.isFromKlein(m) ? "me" : "them";
      const ts   = m.dateCreated || Date.now();
      // indexMessage is non-blocking (fire-and-forget), but we call it in sequence for reindex
      ghost.indexMessage(norm, ts, role, m.text.trim());
      indexed++;
    }
    console.log(`    Queued ${indexed} messages for embedding`);
    totalIndexed += indexed;

    // Small breathe between contacts to avoid hammering the embed API
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n✅ Reindex complete: ${totalIndexed} messages queued`);
  console.log(`   DB: ${HOME}/.openclaw/data/ghost-memories.db`);
  console.log(`   Embeddings are generated asynchronously — re-run in ~60s to verify\n`);

  // Allow pending embed promises to settle
  await new Promise(r => setTimeout(r, 5000));
  process.exit(0);
})().catch(err => {
  console.error(`\n❌ Reindex failed: ${err.message}`);
  process.exit(1);
});
