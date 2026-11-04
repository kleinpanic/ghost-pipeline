"use strict";
/**
 * imsg.js — ghost's native iMessage transport (OpenClaw 2026.10.10 bundled imessage channel).
 *
 * Reads:  `imsg rpc` (JSON-RPC 2.0, one JSON object per line) through the SSH wrapper
 *         ~/.openclaw/tools/imsg-ssh, using the same methods the Gateway's imessage
 *         monitor uses: watch.subscribe, messages.history, chats.list.
 * Send:   `openclaw message send --channel imessage` — the Gateway sends over its own
 *         imsg rpc session.
 * Ask:    `openclaw gateway call plugin.approval.request` — the native approval card
 *         (Discord buttons in #ghost-openclaw, /approve).
 *
 * Hidden constraint: the wrapper runs `ssh -T host imsg "$@"`, so the REMOTE shell parses
 * every argument. Only the fixed argument "rpc" crosses it; all parameters travel on stdin.
 * Never add message text, handles, or other data to the wrapper's argv.
 */

const fs   = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { EventEmitter } = require("events");

const HOME = process.env.HOME || "/home/broklein";
const E164 = /^\+\d{7,15}$/;

// ghost.service runs with PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin, which
// omits the npm global prefix; a bare "openclaw" ENOENTs there (the 90-01 mcporter
// regression class). Resolve the absolute binary first, fall back to PATH lookup.
function resolveBin(candidates, fallback) {
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  return fallback;
}

const OPENCLAW_BIN = process.env.GHOST_OPENCLAW_BIN || resolveBin([
  path.join(HOME, ".local", "share", "npm", "bin", "openclaw"),
  path.join(HOME, ".local", "bin", "openclaw"),
], "openclaw");

const IMSG_CLI = process.env.GHOST_IMSG_CLI || path.join(HOME, ".openclaw", "tools", "imsg-ssh");

const AUTH_DENIED = /authorization denied|code:\s*23\b|full disk access/i;

// Plugin approval limits (src/infra/plugin-approvals.ts:80-83 at v2026.10.10).
const APPROVAL_TITLE_MAX       = 80;
const APPROVAL_DESCRIPTION_MAX = 512;
const APPROVAL_TIMEOUT_MAX_MS  = 600000;

// ─── Payload normalization ──────────────────────────────────────────────────

/**
 * Map an imsg message payload (extensions/imessage/src/monitor/types.ts) to ghost's
 * internal message shape. Group detection uses is_group only, like the Gateway
 * (monitor/inbound-processing.ts:197). The participant list is kept under a different
 * name on purpose: no live DM payload has been seen yet, and if it lists the owner's own
 * handle, a participants-count rule would drop every DM.
 */
function normalizeImsgMessage(p) {
  if (!p || typeof p !== "object") return null;
  const created = typeof p.created_at === "string" ? Date.parse(p.created_at) : NaN;
  return {
    rowid:            Number.isInteger(p.id) ? p.id : null,
    guid:             typeof p.guid === "string" ? p.guid : "",
    chatId:           Number.isInteger(p.chat_id) ? p.chat_id : null,
    chatGuid:         typeof p.chat_guid === "string" ? p.chat_guid : "",
    chatIdentifier:   typeof p.chat_identifier === "string" ? p.chat_identifier : "",
    handle:           { address: typeof p.sender === "string" ? p.sender : "" },
    senderName:       typeof p.sender_name === "string" ? p.sender_name : "",
    text:             typeof p.text === "string" ? p.text : "",
    isFromMe:         p.is_from_me === true,
    dateCreated:      Number.isFinite(created) ? created : 0,
    isGroup:          p.is_group === true,
    isReaction:       p.is_reaction === true || p.is_tapback === true,
    participantHandles: Array.isArray(p.participants) ? p.participants.slice() : [],
  };
}

// ─── JSON-RPC client over the SSH wrapper ───────────────────────────────────

class ImsgRpcClient extends EventEmitter {
  constructor({ cliPath = IMSG_CLI, spawnFn = spawn } = {}) {
    super();
    this.cliPath = cliPath;
    this.spawnFn = spawnFn;
    this.proc    = null;
    this.nextId  = 1;
    this.pending = new Map();
    this.buffer  = "";
    this.stderr  = "";
    this.closed  = false;
  }

  start() {
    // argv is exactly ["rpc"]; see the hidden constraint in the file header.
    this.proc = this.spawnFn(this.cliPath, ["rpc"], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000);
    });
    this.proc.on("error", (err) => this._close(null, err));
    this.proc.on("close", (code) => this._close(code, null));
    return this;
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    let nl;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) {
          const err = new Error(msg.error.message || "imsg rpc error");
          err.code = msg.error.code;
          err.authDenied = AUTH_DENIED.test(err.message);
          reject(err);
        } else {
          resolve(msg.result);
        }
      } else if (msg && typeof msg.method === "string") {
        this.emit("notification", msg);
        if (msg.method === "message" && msg.params && msg.params.message) {
          this.emit("message", msg.params.message);
        }
      }
    }
  }

  _close(code, error) {
    if (this.closed) return;
    this.closed = true;
    const reason = error ? error.message : `imsg rpc exited ${code}: ${this.stderr.trim().slice(-300)}`;
    const authDenied = AUTH_DENIED.test(this.stderr) || AUTH_DENIED.test(reason);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      const err = new Error(reason);
      err.authDenied = authDenied;
      reject(err);
    }
    this.pending.clear();
    this.emit("exit", { code, error, authDenied, stderr: this.stderr });
  }

  request(method, params = {}, timeoutMs = 20000) {
    if (!this.proc || this.closed) return Promise.reject(new Error("imsg rpc not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`imsg rpc ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  stop() {
    if (this.proc && !this.closed) {
      try { this.proc.stdin.end(); } catch {}
      try { this.proc.kill("SIGTERM"); } catch {}
    }
  }
}

/** Run fn(client) against a fresh rpc session, then close it. For CLI commands. */
async function withImsgSession(fn, { createClient = (o) => new ImsgRpcClient(o), cliPath = IMSG_CLI } = {}) {
  const client = createClient({ cliPath }).start();
  try { return await fn(client); } finally { client.stop(); }
}

// ─── Supervised watch (serve mode) ──────────────────────────────────────────

const WATCH_BACKOFF_BASE_MS = 5000;
const WATCH_BACKOFF_MAX_MS  = 10 * 60 * 1000;

function loadCursor(cursorFile) {
  try {
    const d = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
    return Number.isInteger(d.sinceRowid) ? d.sinceRowid : null;
  } catch { return null; }
}

function saveCursor(cursorFile, rowid) {
  try {
    fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
    fs.writeFileSync(cursorFile, JSON.stringify({ sinceRowid: rowid, savedAt: new Date().toISOString() }));
  } catch {}
}

/**
 * Keep one watch.subscribe session alive. The rowid cursor is saved when a message
 * arrives, before it is processed: a crash mid-processing drops that message rather than
 * replaying it (at-most-once; a missed reply is safe, a duplicate draft is not).
 * A missing Full Disk Access grant is logged once per failure streak, then retried with
 * a capped backoff; the service never crash-loops on it.
 */
function startImsgWatch({
  onMessage, log = () => {}, cursorFile,
  createClient = (o) => new ImsgRpcClient(o), cliPath = IMSG_CLI,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
}) {
  let client = null, stopped = false, timer = null, failures = 0, authLogged = false;

  const schedule = () => {
    if (stopped) return;
    const delay = Math.min(WATCH_BACKOFF_BASE_MS * Math.pow(2, failures), WATCH_BACKOFF_MAX_MS);
    failures++;
    timer = setTimeoutFn(connect, delay);
  };

  const onFailure = (err, authDenied) => {
    if (authDenied) {
      if (!authLogged) {
        log("imsg rpc: authorization denied (code 23) — KleinBookPro needs Full Disk Access for the SSH context; inbound is OFF until granted");
        authLogged = true;
      }
    } else {
      log(`imsg rpc: ${String(err && err.message || err).slice(0, 200)}`);
    }
    schedule();
  };

  function connect() {
    if (stopped) return;
    const c = createClient({ cliPath }).start();
    client = c;
    let failed = false;
    const fail = (err, authDenied) => {
      if (failed || stopped) return;
      failed = true;
      if (client === c) client = null;
      c.stop();
      onFailure(err, authDenied);
    };
    c.on("exit", (info) => fail(new Error(`exited ${info.code}: ${String(info.stderr || "").trim().slice(-200)}`), info.authDenied));
    c.on("message", (payload) => {
      const msg = normalizeImsgMessage(payload);
      if (!msg) return;
      if (msg.rowid != null && cursorFile) saveCursor(cursorFile, msg.rowid);
      Promise.resolve().then(() => onMessage(msg)).catch(err => log(`imsg inbound handler error: ${err.message}`));
    });
    const since = cursorFile ? loadCursor(cursorFile) : null;
    const params = { include_reactions: true, attachments: false };
    if (since != null) params.since_rowid = since;
    c.request("watch.subscribe", params, 30000).then(() => {
      failures = 0;
      authLogged = false;
      log(`imsg watch subscribed${since != null ? ` (since rowid ${since})` : ""}`);
    }).catch(err => fail(err, err.authDenied));
  }

  connect();
  return {
    getClient: () => client,
    stop() {
      stopped = true;
      if (timer) clearTimeoutFn(timer);
      if (client) client.stop();
    },
  };
}

// ─── openclaw CLI (send + approval) ─────────────────────────────────────────

function parseCliJson(stdout) {
  const s = (stdout || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  const i = s.lastIndexOf("\n{");
  if (i !== -1) { try { return JSON.parse(s.slice(i + 1)); } catch {} }
  return null;
}

function runOpenclaw(args, { timeoutMs = 60000, execFileFn = execFile, bin = OPENCLAW_BIN } = {}) {
  return new Promise((resolve) => {
    execFileFn(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, HOME } },
      (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, json: parseCliJson(stdout), stderr: String(stderr || "") });
      });
  });
}

/**
 * Send one iMessage through the Gateway's native imessage channel. The target must be an
 * E.164 handle; chat ids and guids are refused here, before any process starts.
 */
async function sendIMessageNative(target, text, opts = {}) {
  if (typeof target !== "string" || !E164.test(target)) {
    return { ok: false, error: `target is not E.164: ${String(target).slice(0, 32)}` };
  }
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "empty text" };
  const r = await runOpenclaw(
    ["message", "send", "--channel", "imessage", "--target", target, "--message", text, "--json"],
    { timeoutMs: 60000, ...opts },
  );
  if (r.ok && r.json && r.json.ok !== false) return { ok: true, result: r.json };
  const msg = r.json?.error?.message || r.stderr.trim().slice(-200) || `exit ${r.code}`;
  return { ok: false, error: msg };
}

/**
 * Ask the owner through a native plugin approval and wait for the decision.
 * One blocking call per request: the approval record binds to the requesting
 * connection, so a second CLI cannot wait for or resolve it (probe 1 and 3, 2026-11-04).
 * Resolves "allow-once" | "deny" | null (expired, or any failure). Only "allow-once"
 * may lead to a send.
 */
async function requestOwnerApproval({
  title, description, timeoutMs, channelId, agentId = "ghost", severity = "info",
}, opts = {}) {
  if (!title || title.length > APPROVAL_TITLE_MAX) return { decision: null, error: "title too long" };
  if (!description || description.length > APPROVAL_DESCRIPTION_MAX) return { decision: null, error: "description too long" };
  if (!channelId) return { decision: null, error: "no approval channel" };
  const t = Math.max(30000, Math.min(timeoutMs || 120000, APPROVAL_TIMEOUT_MAX_MS));
  const params = {
    pluginId:          "ghost-pipeline",
    title,
    description,
    allowedDecisions:  ["allow-once", "deny"],
    agentId,
    // The session key plus turn source route the card to the Discord native approval
    // handler (execApprovals.sessionFilter "discord:channel:", target "channel").
    // Without them the request has no channel route (probe 1: deliveryRoute approval-client).
    sessionKey:        `agent:${agentId}:discord:channel:${channelId}`,
    turnSourceChannel: "discord",
    turnSourceTo:      `channel:${channelId}`,
    severity,
    timeoutMs:         t,
  };
  const r = await runOpenclaw(
    ["gateway", "call", "plugin.approval.request", "--json", "--timeout", String(t + 30000), "--params", JSON.stringify(params)],
    { timeoutMs: t + 45000, ...opts },
  );
  if (!r.ok || !r.json) return { decision: null, error: r.json?.error?.message || r.stderr.trim().slice(-200) || `exit ${r.code}` };
  const d = r.json.decision;
  return { decision: d === "allow-once" || d === "deny" ? d : null, id: r.json.id || null };
}

module.exports = {
  E164,
  OPENCLAW_BIN,
  IMSG_CLI,
  APPROVAL_TITLE_MAX,
  APPROVAL_DESCRIPTION_MAX,
  APPROVAL_TIMEOUT_MAX_MS,
  WATCH_BACKOFF_BASE_MS,
  WATCH_BACKOFF_MAX_MS,
  resolveBin,
  normalizeImsgMessage,
  ImsgRpcClient,
  withImsgSession,
  startImsgWatch,
  loadCursor,
  saveCursor,
  parseCliJson,
  runOpenclaw,
  sendIMessageNative,
  requestOwnerApproval,
};
