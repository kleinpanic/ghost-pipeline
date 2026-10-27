# ghost-pipeline

Klein's iMessage auto-reply agent. Reads incoming texts via BlueBubbles webhook, generates drafts mimicking Klein's voice, posts them to Discord for review, and auto-sends after a per-contact cooldown (1.5–7.5 min depending on relationship category and conversation activity) unless cancelled.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  ghost-pipeline (this repo)                                  │
│  ~/codeWS/JavaScript/ghost-pipeline/src/ghost.js             │
│  ← symlinked from ~/.openclaw/hooks/ghost.js                 │
│                                                              │
│  Webhook server (port 18790):                                │
│    POST /bluebubbles/message-sent  ← BB webhook              │
│    POST /action                    ← send/cancel draft       │
│    POST /approve-contact           ← approve unknown         │
│    POST /deny-contact              ← deny unknown            │
│    GET  /pending, /health          ← status                  │
└───────────┬─────────────────────────────┬────────────────────┘
            │                             │
            ▼                             ▼
┌───────────────────────┐  ┌─────────────────────────────────┐
│  BlueBubbles MCP      │  │  OC pre-message hook             │
│  ~/code/bluebubbles-  │  │  ~/.openclaw/hooks/pre-message/  │
│  mcp (on Collins)     │  │  handler.js                      │
│  SSH fwd: 18800→18801 │  │  Routes Discord button clicks    │
│  20 iMessage tools    │  │  to ghost HTTP /action endpoint  │
│  via mcporter         │  │  (also: autonomous intent        │
└───────────────────────┘  │   detection — unrelated to ghost)│
                           └─────────────────────────────────┘
```

### Dependencies
- **BlueBubbles server** on a macOS host (configured via `BB_HOST`/`BB_PORT` in `.env`)
- **BB MCP server** forwarded via SSH tunnel (configured in `.env`)
- **OpenClaw pre-message hook** (handler.js) bridges Discord button clicks → ghost /action
- **OpenRouter API** for draft generation (model waterfall)
- **Node.js ≥ 20** (`better-sqlite3` ships prebuilt binaries for current LTS releases)
- **Discord** channel for draft review (configured via `GHOST_CHANNEL_ID` in `.env`)

## Pipeline Flow

```
BlueBubbles on macOS host ──webhook──▶ ghost.js :18790
                                       │
                              allowlist + quiet hours check
                                       │
                              draft generation chain (OpenRouter,
                              first success that passes content safety):
                                gpt-oss-120b:free
                                → gemini-3.1-flash-lite-preview
                                → gemini-3-flash-preview
                                → claude-haiku-4.5
                                       │
                              Discord #ghost-openclaw
                              [✅ Send] [❌ Cancel] (per-contact cooldown)
                                       │
                              auto-send via BlueBubbles MCP
```

## Setup

```bash
npm ci                  # install (Node ≥ 20)
cp .env.example .env    # then fill in BB_HOST, GHOST_CHANNEL_ID, OWNER_PHONE, …
npm start               # = node src/ghost.js serve
```

Secrets are read from `~/.config/bluebubbles/password`, `~/.config/openrouter/api-key`,
`~/.config/discord/bot-token` and `~/.openclaw/.gateway-token` (the gateway token can also
come from `OC_GATEWAY_TOKEN`; the others are file-only).

### HTTP API access

The server binds `GHOST_BIND_HOST` (default `0.0.0.0`, since BlueBubbles posts from another host).

- `/action`, `/approve-contact`, `/deny-contact`, `/pending` accept requests from loopback
  (the local OpenClaw hook) only, unless the caller presents `GHOST_API_TOKEN`.
- `/bluebubbles/message-sent` requires `GHOST_API_TOKEN` when it is set — configure the
  BlueBubbles webhook URL as `http://<ghost-host>:18790/bluebubbles/message-sent?token=<token>`.
  **Set it**: without a token anyone on the network can inject fake inbound messages.
- The token may be sent as `Authorization: Bearer <token>`, `X-Ghost-Token: <token>` or `?token=<token>`.

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
systemctl --user start   bluebubbles-webhook.service
systemctl --user stop    bluebubbles-webhook.service
systemctl --user restart bluebubbles-webhook.service
systemctl --user status  bluebubbles-webhook.service

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

- **BlueBubbles required**: must be running on `collins` (BB_HOST:BB_PORT (see .env))
- **MCP tunnel dependency**: SSH LocalForward `localhost:18800 → macOS-host:18791` must be up for MCP path; falls back to direct BB HTTP if tunnel is down
- **PinePhone (Emmet)**: BlueBubbles iMessage delivery to PinePhone numbers is intermittent
- **No group chat replies**: ghost only handles 1-on-1 iMessage threads; group chats are skipped
- **Apple Contacts enrichment**: requires `mcporter` + `bb_contact_query` — degrades gracefully if unavailable
