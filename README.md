# ghost-pipeline

Klein's iMessage drafting agent. Watches incoming texts through OpenClaw's native iMessage
transport (`imsg rpc`), drafts a reply in Klein's voice, posts it to Discord, and asks the owner
through a native OpenClaw approval card. It sends only after **Allow Once**; an unanswered card
expires unsent. Nothing sends on a timer.

## Architecture

```
 Mac signed into Messages (imsg)          broklein
 ┌──────────────────────────┐     ssh     ┌────────────────────────────────────────────┐
 │ imsg rpc  (JSON-RPC 2.0) │◀───────────▶│ ghost.js serve                             │
 │ chat.db + Messages.app   │  imsg-ssh   │   watch.subscribe → preflight → draft      │
 └──────────────────────────┘             │   messages.history (context, collisions)   │
                                          │                                            │
                                          │   openclaw gateway call                    │
                                          │     plugin.approval.request ──▶ Discord    │
                                          │     card: Allow Once / Deny                │
                                          │                                            │
                                          │   openclaw message send                    │
                                          │     --channel imessage --target +E164      │
                                          │                                            │
                                          │   GET /health, /pending (127.0.0.1:PORT)   │
                                          └────────────────────────────────────────────┘
```

- **Read**: `src/imsg.js` runs `~/.openclaw/tools/imsg-ssh rpc` (override: `GHOST_IMSG_CLI`),
  the same wrapper and methods the Gateway's imessage channel uses. Only the argument `rpc`
  crosses SSH; all data travels on stdin, because the remote shell parses the wrapper's argv.
  The last rowid seen is kept in `data/ghost-imsg-cursor.json`.
- **Ask**: one blocking `plugin.approval.request` per draft (and per unknown number), routed to
  the ghost Discord channel. The approval binds to that connection, so a restart loses it:
  drafts pending at startup expire unsent.
- **Send**: the Gateway's own imessage channel. The target is always the contact's E.164
  handle; ghost refuses anything else before a process starts.

### Fail-closed send rules

A send happens only when all of these hold, in this order: send toggle on
(`data/ghost-send-enabled.json` `{"enabled": true}` or `GHOST_SEND_ENABLED=1`), not paused,
the draft is still pending, the approved text equals the draft text, the recipient is an
allowlisted E.164 handle (or the owner), Klein has not replied in the thread, no internal-text
markers, and the per-contact rate gate and send lock allow it. One approval gives one attempt;
a failed send is reported, never retried.

### Dependencies
- **A Mac signed into Messages with `imsg`** (Homebrew), reachable as the `imsg-ssh` wrapper's
  host. Reads need Full Disk Access for the SSH context (Remote Login: "Allow full disk
  access for remote users"). Sends need Messages Automation, which macOS does not keep for
  `sshd-keygen-wrapper`; the Gateway's send path needs an `imsg` running in the logged-in
  user's session (installed docs `channels/imessage/setup.md`).
- **OpenClaw Gateway** with the bundled `imessage` channel enabled and owner-only admission,
  and Discord native approvals for the ghost channel.
- **OpenRouter API** for draft generation (model waterfall)
- **Node.js ≥ 20** (`better-sqlite3` ships prebuilt binaries for current LTS releases)
- **Discord** channel for draft review (`GHOST_CHANNEL_ID` in `.env`)

## Pipeline Flow

```
imsg watch.subscribe ──▶ ghost.js
                           │
                  group / reaction / age / spam / injection / allowlist / quiet hours
                           │   (unknown number → approval card: allowlist or deny)
                           │
                  30 s debounce, then draft generation chain (OpenRouter,
                  first success that passes content safety)
                           │
                  Discord #ghost-openclaw: draft + native approval card
                           │
                  Allow Once ──▶ openclaw message send --channel imessage
                  Deny / no answer ──▶ nothing sent
```

## Setup

```bash
npm ci                  # install (Node ≥ 20)
cp .env.example .env    # then fill in GHOST_CHANNEL_ID, OWNER_PHONE, …
npm start               # = node src/ghost.js serve
```

Secrets are read from `~/.config/openrouter/api-key` and `~/.config/discord/bot-token`
(file-only). `openclaw` is resolved from the npm global prefix (override: `GHOST_OPENCLAW_BIN`),
because the systemd unit's PATH does not include it.

### HTTP API access

The status server binds `GHOST_BIND_HOST` (default `127.0.0.1`). Nothing posts to ghost; the
only routes are `GET /health` and `GET /pending`. `/pending` answers loopback callers, or a
caller presenting `GHOST_API_TOKEN` (`Authorization: Bearer <token>`, `X-Ghost-Token` or
`?token=`).

## Symlink Layout

codeWS is the source of truth:

```
~/codeWS/JavaScript/ghost-pipeline/src/ghost.js   ← edit here
~/.openclaw/hooks/ghost.js                         → symlink to above
~/codeWS/JavaScript/ghost-pipeline/workspace       → symlink to ~/.openclaw/workspace-ghost
```

## Contact Categories

Defined in `workspace/governance/CONTACTS.md`. Controls tone, quiet hours, and send policy.

| Category | Quiet Hours | Tone | Examples |
|---|---|---|---|
| `family_close` | 10pm–8am | Warm, brief, no crude slang, capital I | Brenda, Nick |
| `close_friend` | 11pm–8am | Full Klein — slang, fragmented, technical OK | Sri, Will, Jai, Emmet, Sam J |
| `friend` | 11pm–8am | Casual but slightly more composed | Gibbs, Max K |
| `acquaintance` | 10pm–8am | Polite-casual, no heavy slang | (none currently) |

### Adding a contact

Edit `workspace/governance/CONTACTS.md`, add a line inside the `CONTACT_ALLOWLIST` block:

```
- DisplayName | +1XXXXXXXXXX | ask | category | Label
```

Example:
```
- Alex | +14155550100 | ask | close_friend | Friend
```

Then add a contact memory file: `workspace/memory/contacts/1XXXXXXXXXX-name.md`

## Service Management

```bash
systemctl --user start   ghost.service
systemctl --user stop    ghost.service
systemctl --user restart ghost.service
systemctl --user status  ghost.service

node src/ghost.js status   # live status + pending drafts
node src/ghost.js pause    # pause indefinitely
node src/ghost.js resume   # resume
node src/ghost.js learn --all   # rebuild all contact memories + voice profile
```

## Test Suite

```bash
npm run lint          # eslint
npm test              # all tests (unit, integration, e2e) + coverage
npm run test:unit     # unit tests only (fast, no server needed)
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run lint` and `npm test` on Node 20 and 22,
plus `npm audit --audit-level=high`.

Tests use **fake phone numbers only** — no real contacts are referenced in test fixtures.
The `isFromKlein.regression.test.js` file specifically guards the bug that caused ghost to
text Klein's mom at 1:25am (MCP returns `from:"me"` not `isFromMe:true`).

## Known Limits

- **Mac permissions**: without Full Disk Access for the SSH context, `imsg rpc` fails with
  code 23; ghost logs it once and retries with a capped backoff (inbound is off meanwhile).
- **Restart drops approvals**: pending drafts expire unsent at startup; reply manually.
- **No group chat replies**: ghost only handles 1-on-1 iMessage threads; group chats are skipped
- **Contact names**: an unknown number's name comes from imsg's Contacts lookup (`sender_name`) when the Mac has it.
