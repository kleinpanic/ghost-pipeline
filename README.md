# ghost-pipeline

Klein's iMessage auto-reply agent. Reads incoming texts via BlueBubbles webhook, generates drafts mimicking Klein's voice, posts them to Discord for review, and auto-sends after a 5-minute window.

## Architecture

```
BlueBubbles (collins) ──webhook──▶ ghost.js :18790
                                       │
                              allowlist + quiet hours check
                                       │
                              draft generation chain:
                                Spark-20b (local fast)
                                → Ghost Agent (full context, Claude)
                                → Gemini CLI
                                → gemma-27b / gemma-12b (OR free)
                                → Spark-120b (local fallback)
                                       │
                              Discord #ghost-openclaw
                              [✅ Send] [❌ Cancel] (5-min window)
                                       │
                              auto-send via BlueBubbles MCP
```

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
npm test              # all tests + coverage
npm run test:unit     # unit tests only (fast, no server needed)
```

Tests use **fake phone numbers only** — no real contacts are referenced in test fixtures.
The `isFromKlein.regression.test.js` file specifically guards the bug that caused ghost to
text Klein's mom at 1:25am (MCP returns `from:"me"` not `isFromMe:true`).

## Known Limits

- **BlueBubbles required**: must be running on `collins` (10.0.0.196:1234)
- **MCP tunnel dependency**: SSH LocalForward `broklein:18800 → collins:18791` must be up for MCP path; falls back to direct BB HTTP if tunnel is down
- **PinePhone (Emmet)**: BlueBubbles iMessage delivery to PinePhone numbers is intermittent
- **No group chat replies**: ghost only handles 1-on-1 iMessage threads; group chats are skipped
- **Apple Contacts enrichment**: requires `mcporter` + `bb_contact_query` — degrades gracefully if unavailable
