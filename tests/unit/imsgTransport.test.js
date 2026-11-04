"use strict";
/**
 * NAT-25 (2026-11-04): native iMessage transport — imsg rpc reads, native send, native
 * owner approval. Shapes are the Gateway's own (v2026.10.10 extensions/imessage).
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const imsg = require("../../src/imsg");

function fakeProc() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.written = [];
  p.stdin = { write: (s) => p.written.push(s), end: () => {} };
  p.kill = () => {};
  p.reply = (obj) => p.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  return p;
}

function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => { const proc = fakeProc(); calls.push({ cmd, args, opts, proc }); return proc; };
  fn.calls = calls;
  return fn;
}

const flush = () => new Promise(r => setImmediate(r));

describe("normalizeImsgMessage", () => {
  test("maps the imsg payload to ghost's message shape", () => {
    const m = imsg.normalizeImsgMessage({
      id: 901, guid: "G-1", chat_id: 42, chat_guid: "any;-;+15551234567", chat_identifier: "+15551234567",
      sender: "+15551234567", sender_name: "Alex", is_from_me: false, text: "hey",
      created_at: "2026-11-04T10:00:00.000Z", is_group: false, participants: ["+15551234567", "+12673479614"],
    });
    expect(m).toMatchObject({
      rowid: 901, guid: "G-1", chatId: 42, chatGuid: "any;-;+15551234567", chatIdentifier: "+15551234567",
      handle: { address: "+15551234567" }, senderName: "Alex", text: "hey", isFromMe: false,
      dateCreated: Date.parse("2026-11-04T10:00:00.000Z"), isGroup: false, isReaction: false,
    });
  });

  test("group detection uses is_group only; participants never become a group signal", () => {
    const m = imsg.normalizeImsgMessage({ id: 1, is_group: false, participants: ["+1555", "+1267"] });
    expect(m.isGroup).toBe(false);
    expect(m.participants).toBeUndefined();
    expect(m.participantHandles).toEqual(["+1555", "+1267"]);
    expect(imsg.normalizeImsgMessage({ id: 2, is_group: true }).isGroup).toBe(true);
  });

  test("tapbacks and reactions are flagged", () => {
    expect(imsg.normalizeImsgMessage({ is_tapback: true }).isReaction).toBe(true);
    expect(imsg.normalizeImsgMessage({ is_reaction: true }).isReaction).toBe(true);
  });

  test("missing or bad fields degrade to safe defaults", () => {
    const m = imsg.normalizeImsgMessage({ created_at: "not a date", is_from_me: "yes" });
    expect(m.dateCreated).toBe(0);
    expect(m.isFromMe).toBe(false);
    expect(m.rowid).toBeNull();
    expect(imsg.normalizeImsgMessage(null)).toBeNull();
  });
});

describe("ImsgRpcClient", () => {
  test("spawns the wrapper with argv exactly ['rpc'] and frames JSON-RPC 2.0 lines on stdin", async () => {
    const spawnFn = fakeSpawn();
    const c = new imsg.ImsgRpcClient({ cliPath: "/x/imsg-ssh", spawnFn }).start();
    const p = c.request("chats.list", { limit: 5 });
    const { cmd, args, proc } = spawnFn.calls[0];
    expect(cmd).toBe("/x/imsg-ssh");
    expect(args).toEqual(["rpc"]);
    expect(proc.written).toEqual([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "chats.list", params: { limit: 5 } }) + "\n"]);
    proc.reply({ jsonrpc: "2.0", id: 1, result: { chats: [{ id: 7 }] } });
    await expect(p).resolves.toEqual({ chats: [{ id: 7 }] });
  });

  test("a JSON-RPC error rejects the request", async () => {
    const spawnFn = fakeSpawn();
    const c = new imsg.ImsgRpcClient({ spawnFn }).start();
    const p = c.request("messages.history", { chat_id: 1 });
    spawnFn.calls[0].proc.reply({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "authorization denied (code: 23)" } });
    await expect(p).rejects.toMatchObject({ authDenied: true });
  });

  test("message notifications are emitted; split lines are reassembled", () => {
    const spawnFn = fakeSpawn();
    const c = new imsg.ImsgRpcClient({ spawnFn }).start();
    const got = [];
    c.on("message", (m) => got.push(m));
    const line = JSON.stringify({ jsonrpc: "2.0", method: "message", params: { message: { id: 5, text: "hi" } } }) + "\n";
    const proc = spawnFn.calls[0].proc;
    proc.stdout.emit("data", Buffer.from(line.slice(0, 10)));
    proc.stdout.emit("data", Buffer.from(line.slice(10)));
    expect(got).toEqual([{ id: 5, text: "hi" }]);
  });

  test("process exit rejects pending requests and reports Full Disk Access denial", async () => {
    const spawnFn = fakeSpawn();
    const c = new imsg.ImsgRpcClient({ spawnFn }).start();
    const exits = [];
    c.on("exit", (e) => exits.push(e));
    const p = c.request("watch.subscribe", {});
    const proc = spawnFn.calls[0].proc;
    proc.stderr.emit("data", Buffer.from("Error: authorization denied (code: 23)\n"));
    proc.emit("close", 1);
    await expect(p).rejects.toMatchObject({ authDenied: true });
    expect(exits[0].authDenied).toBe(true);
    await expect(c.request("chats.list", {})).rejects.toThrow(/not running/);
  });
});

describe("startImsgWatch", () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-imsg-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  test("subscribes with since_rowid from the cursor and saves the cursor per message", async () => {
    const cursorFile = path.join(tmp, "cursor.json");
    imsg.saveCursor(cursorFile, 100);
    const spawnFn = fakeSpawn();
    const seen = [];
    const w = imsg.startImsgWatch({
      cursorFile, onMessage: (m) => seen.push(m),
      createClient: (o) => new imsg.ImsgRpcClient({ ...o, spawnFn }),
    });
    const proc = spawnFn.calls[0].proc;
    expect(JSON.parse(proc.written[0])).toMatchObject({
      method: "watch.subscribe", params: { since_rowid: 100, include_reactions: true, attachments: false },
    });
    proc.reply({ jsonrpc: "2.0", id: 1, result: { subscription: 1 } });
    proc.reply({ jsonrpc: "2.0", method: "message", params: { message: { id: 101, text: "yo", sender: "+15551234567" } } });
    await flush();
    expect(imsg.loadCursor(cursorFile)).toBe(101);
    expect(seen[0]).toMatchObject({ rowid: 101, text: "yo", handle: { address: "+15551234567" } });
    w.stop();
  });

  test("no cursor → no since_rowid (stream starts at now, no history replay)", () => {
    const spawnFn = fakeSpawn();
    const w = imsg.startImsgWatch({
      cursorFile: path.join(tmp, "none.json"), onMessage: () => {},
      createClient: (o) => new imsg.ImsgRpcClient({ ...o, spawnFn }),
    });
    expect(JSON.parse(spawnFn.calls[0].proc.written[0]).params.since_rowid).toBeUndefined();
    w.stop();
  });

  test("Full Disk Access denial: logged once, retried with doubling capped backoff, no throw", async () => {
    const spawnFn = fakeSpawn();
    const logs = [], delays = [], timers = [];
    const w = imsg.startImsgWatch({
      onMessage: () => {}, log: (m) => logs.push(m),
      createClient: (o) => new imsg.ImsgRpcClient({ ...o, spawnFn }),
      setTimeoutFn: (fn, ms) => { delays.push(ms); timers.push(fn); return timers.length; },
      clearTimeoutFn: () => {},
    });
    for (let i = 0; i < 9; i++) {
      const proc = spawnFn.calls[i].proc;
      proc.stderr.emit("data", Buffer.from("authorization denied (code: 23)"));
      proc.emit("close", 1);
      await flush();
      timers[i]();
    }
    expect(logs.filter(l => /Full Disk Access/.test(l))).toHaveLength(1);
    expect(delays.slice(0, 3)).toEqual([5000, 10000, 20000]);
    expect(Math.max(...delays)).toBe(imsg.WATCH_BACKOFF_MAX_MS);
    w.stop();
  });
});

function fakeExecFile(stdout, err = null) {
  const calls = [];
  const fn = (bin, args, opts, cb) => { calls.push({ bin, args, opts }); cb(err, stdout, ""); };
  fn.calls = calls;
  return fn;
}

describe("sendIMessageNative", () => {
  test.each(["42", "any;-;+15551234567", "iMessage;+;chat123", "15551234567", "+1555", "", null])(
    "refuses non-E.164 target %p before any process starts", async (target) => {
      const execFileFn = fakeExecFile("{}");
      const r = await imsg.sendIMessageNative(target, "hi", { execFileFn });
      expect(r.ok).toBe(false);
      expect(execFileFn.calls).toHaveLength(0);
    });

  test("argv is the native message send; text is one argv element (no shell)", async () => {
    const execFileFn = fakeExecFile(JSON.stringify({ ok: true }));
    const r = await imsg.sendIMessageNative("+15551234567", "it's \"fine\" $(x)", { execFileFn, bin: "/b/openclaw" });
    expect(r.ok).toBe(true);
    expect(execFileFn.calls[0].bin).toBe("/b/openclaw");
    expect(execFileFn.calls[0].args).toEqual([
      "message", "send", "--channel", "imessage", "--target", "+15551234567", "--message", "it's \"fine\" $(x)", "--json",
    ]);
  });

  test("CLI ok:false (channel unavailable) is a failed send", async () => {
    const out = JSON.stringify({ ok: false, error: { type: "cli_error", message: "Channel is unavailable: imessage" } });
    const err = Object.assign(new Error("exit 1"), { code: 1 });
    const r = await imsg.sendIMessageNative("+15551234567", "hi", { execFileFn: fakeExecFile(out, err) });
    expect(r).toEqual({ ok: false, error: "Channel is unavailable: imessage" });
  });
});

describe("requestOwnerApproval", () => {
  const base = { title: "Ghost draft → Alex", description: "hey sounds good", timeoutMs: 300000, channelId: "1474492563418517515" };

  test("params route the card to #ghost-openclaw via session key + turn source", async () => {
    const execFileFn = fakeExecFile(JSON.stringify({ id: "plugin:abc", decision: "allow-once" }));
    const r = await imsg.requestOwnerApproval(base, { execFileFn });
    expect(r).toEqual({ decision: "allow-once", id: "plugin:abc" });
    const args = execFileFn.calls[0].args;
    expect(args.slice(0, 4)).toEqual(["gateway", "call", "plugin.approval.request", "--json"]);
    expect(args[args.indexOf("--timeout") + 1]).toBe("330000");
    const params = JSON.parse(args[args.indexOf("--params") + 1]);
    expect(params).toEqual({
      pluginId: "ghost-pipeline", title: base.title, description: base.description,
      allowedDecisions: ["allow-once", "deny"], agentId: "ghost",
      sessionKey: "agent:ghost:discord:channel:1474492563418517515",
      turnSourceChannel: "discord", turnSourceTo: "channel:1474492563418517515",
      severity: "info", timeoutMs: 300000,
    });
  });

  test.each([
    [{ decision: "deny" }, "deny"],
    [{ decision: null }, null],
    [{ decision: "allow-always" }, null],
    [{}, null],
  ])("decision %p maps to %p", async (out, expected) => {
    const r = await imsg.requestOwnerApproval(base, { execFileFn: fakeExecFile(JSON.stringify(out)) });
    expect(r.decision).toBe(expected);
  });

  test("CLI failure → decision null (fail closed)", async () => {
    const r = await imsg.requestOwnerApproval(base, { execFileFn: fakeExecFile("", Object.assign(new Error("x"), { code: 1 })) });
    expect(r.decision).toBeNull();
  });

  test("over-limit title/description refused without a call; timeout clamped to 600 s", async () => {
    const execFileFn = fakeExecFile(JSON.stringify({ decision: "allow-once" }));
    expect((await imsg.requestOwnerApproval({ ...base, description: "x".repeat(513) }, { execFileFn })).decision).toBeNull();
    expect((await imsg.requestOwnerApproval({ ...base, title: "t".repeat(81) }, { execFileFn })).decision).toBeNull();
    expect(execFileFn.calls).toHaveLength(0);
    await imsg.requestOwnerApproval({ ...base, timeoutMs: 9e9 }, { execFileFn });
    const params = JSON.parse(execFileFn.calls[0].args[execFileFn.calls[0].args.indexOf("--params") + 1]);
    expect(params.timeoutMs).toBe(600000);
  });
});

describe("OPENCLAW_BIN resolution (service PATH omits the npm prefix)", () => {
  test("resolveBin prefers an executable absolute candidate, else the fallback", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-bin-"));
    const bin = path.join(tmp, "openclaw");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    expect(imsg.resolveBin([path.join(tmp, "missing"), bin], "openclaw")).toBe(bin);
    expect(imsg.resolveBin([path.join(tmp, "missing")], "openclaw")).toBe("openclaw");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("on a host with the npm-global install, OPENCLAW_BIN is absolute", () => {
    const npmBin = path.join(process.env.HOME || "", ".local", "share", "npm", "bin", "openclaw");
    if (!fs.existsSync(npmBin) || process.env.GHOST_OPENCLAW_BIN) return;
    expect(imsg.OPENCLAW_BIN).toBe(npmBin);
  });
});
