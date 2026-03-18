# Ghost Pipeline — Dev Spec
_Author: main | Date: 2026-03-18 | Priority: high_

## Overview

Ghost is Klein's iMessage auto-reply agent. The pipeline lives in `~/.openclaw/hooks/ghost.js`
(~1750 lines, Node.js). This spec covers three work items to hand off to dev:

1. **Category-aware system prompt injection** (medium, ~100 lines)
2. **End-to-end test suite** (large, new `tests/` directory)
3. **codeWS migration + symlink setup** (medium, repo structure)

---

## 1. Category-Aware System Prompt Injection

### Context
`CONTACTS.md` now has a `category` field per contact (family_close, close_friend, friend, acquaintance).
ghost.js currently parses CONTACTS.md with `loadContactsMap()` but only extracts `alias/name/policy`.
Category is ignored. `buildSystemPrompt()` uses SOUL.md + voice-profile + contact memory but has no
category-level tone guidance.

### What to implement

**A) Parse `category` from CONTACTS.md in `loadContactsMap()`**

The allowlist line format is now:
```
- Brenda Schaufele | +14847070468 | ask | family_close | Mom
```
Fields (0-indexed): `[name, phone, policy, category, alias, ...notes]`

Add `numToCategory: { [normalized]: string }` to the returned map.

**B) Add `CATEGORY_TONE` lookup object** near top of ghost.js:

```js
const CATEGORY_TONE = {
  family_close: `
Relationship: immediate family. Klein is warm but VERY brief with family.
- Keep replies under ~40 characters when possible.
- Never use crude slang ("bruh", "lmfao", "nigga"). Use "yeah", "idk", "rlly".
- Capital I (Klein does NOT lowercase his pronoun with family).
- High emotional sensitivity — mirror their energy briefly.
- Never initiate topics. Just respond.`,

  close_friend: `
Relationship: close friend Klein talks to daily/weekly.
- Full Klein casual energy: fragmented multi-burst style, full slang vocabulary.
- "bruh", "lmfao", "lowkey", "bet", "fs", "wild", "cooked" all fine.
- Technical jargon OK if they're a tech peer (Sri, Jai).
- Split long thoughts into 2-3 separate short messages.
- Match their energy exactly — if they're hyped, match it; if low-key, chill.`,

  friend: `
Relationship: regular friend, solid but not daily contact.
- Casual Klein but slightly more composed than close friends.
- Slang OK, heavy crude slang rare.
- Warmer tone, less clipped than close friends.`,

  acquaintance: `
Relationship: classmate, coworker, or infrequent contact.
- Polite-casual. Lowercase, minimal punctuation, brief.
- No crude slang. No heavy slang.
- Friendly but not overly familiar.`,
};
```

**C) Inject category tone into `buildSystemPrompt(contactName, contact)`:**

```js
function buildSystemPrompt(contactName, contact) {
  const { numToCategory } = loadContactsMap();
  const category = numToCategory[normalizePhone(contact)] || "friend";
  const categoryTone = CATEGORY_TONE[category] || CATEGORY_TONE.friend;

  const soul    = readFileSafe(SOUL_FILE);
  const voice   = readFileSafe(VOICE_PROFILE_FILE);
  const memory  = readFileSafe(path.join(CONTACTS_MEMORY_DIR, `${normalizePhone(contact)}-*.md`));
  // ... existing logic, then append:
  return `${soul}\n\n${voice}\n\n## Category Context\n${categoryTone}\n\n## Contact Memory\n${memory}`;
}
```

Note: the contact memory file glob currently uses a literal path — fix to use `fs.readdirSync` to find
the right file by prefix matching on normalized phone.

**D) Pass `category` into pending draft metadata** so `executeSend` can use it for quiet hours:

Currently `isQuietHours(contact)` checks `FAMILY_PHONES` hardcoded set. Replace with category lookup:
- `family_close` || `acquaintance` → 22:00 quiet start
- `close_friend` || `friend` → 23:00 quiet start

Remove hardcoded `FAMILY_PHONES` set.

---

## 2. End-to-End Test Suite

### Location
```
~/codeWS/JavaScript/ghost-pipeline/tests/
├── unit/
│   ├── normalizePhone.test.js
│   ├── isQuietHours.test.js
│   ├── requiresReply.test.js
│   ├── isFromKlein.test.js
│   ├── extractBBList.test.js
│   ├── findChatsForPhone.test.js
│   ├── isDenied.test.js
│   ├── isLikelySpam.test.js
│   └── kleinRepliedSince.test.js   (mock spawnAsync)
└── integration/
    ├── webhook-allowlist.test.js   (POST to running ghost, verify response)
    ├── webhook-denylist.test.js
    ├── webhook-quiet-hours.test.js
    ├── webhook-owner-reply.test.js  (isFromMe cancels pending)
    ├── webhook-chatguid-missing.test.js  (triggers resolveChatGuid)
    ├── draft-lifecycle.test.js     (queue → Discord post → auto-send → confirm)
    └── kleinRepliedSince-blocks.test.js  (MCP mock → block auto-send)
```

### Framework: Jest + nock (HTTP mocking)

```json
// package.json
{
  "scripts": {
    "test": "jest",
    "test:unit": "jest tests/unit",
    "test:integration": "jest tests/integration"
  },
  "devDependencies": {
    "jest": "^29",
    "nock": "^13"
  }
}
```

### Key test cases to cover

**Unit — `isQuietHours(phone)`:**
```js
test("family contact blocked after 10pm", () => {
  jest.setSystemTime(new Date("2026-03-18T02:30:00Z")); // 10:30pm ET
  expect(isQuietHours("14847070468")).toBe(true);  // Mom
});
test("close friend NOT blocked at 10:30pm", () => {
  jest.setSystemTime(new Date("2026-03-18T02:30:00Z")); // 10:30pm ET
  expect(isQuietHours("15715775911")).toBe(false); // Sri
});
test("close friend blocked after 11pm", () => {
  jest.setSystemTime(new Date("2026-03-18T04:00:00Z")); // midnight ET
  expect(isQuietHours("15715775911")).toBe(true);
});
```

**Unit — `kleinRepliedSince(chatGuid, since)` with mocked MCP:**
```js
// Mock spawnAsync to return fake bb_get_chat_messages response
// Verify: from:"me" is detected (not just isFromMe)
test("detects klein reply via from:me field", async () => {
  mockMcporter({ messages: [{ from: "me", dateCreated: Date.now() }] });
  expect(await kleinRepliedSince("iMessage;-;+15715775911", new Date(Date.now() - 60000).toISOString()))
    .toBe(true);
});
test("does not block send when no reply", async () => {
  mockMcporter({ messages: [{ from: "+15715775911", dateCreated: Date.now() }] });
  expect(await kleinRepliedSince("iMessage;-;+15715775911", new Date(Date.now() - 60000).toISOString()))
    .toBe(false);
});
```

**Integration — webhook quiet hours blocks send to Mom:**
```js
test("POST from Mom during quiet hours returns quiet_hours action", async () => {
  jest.setSystemTime(/* 10:30pm ET */);
  const res = await postWebhook({ chatGuid: "iMessage;-;+14847070468", handle: "+14847070468", text: "hey" });
  expect(res.action).toBe("quiet_hours");
});
```

**Integration — stale lock does not block reaction check:**
- Create lock file manually
- Restart cmdServe
- Verify lock is cleared and reaction check runs

**Integration — chatGuid resolution:**
- POST webhook with no chatGuid
- Verify `resolveChatGuid` is called (mock bb HTTP)
- Verify resolved guid is used in draft

### Test runner script
```bash
# tests/run-tests.sh
cd ~/codeWS/JavaScript/ghost-pipeline
npm test -- --coverage --coverageDirectory=coverage
```

---

## 3. codeWS Migration + Symlink

### Target structure
```
~/codeWS/JavaScript/ghost-pipeline/
├── src/
│   └── ghost.js                   ← main source
├── workspace/                     ← symlink → ~/.openclaw/workspace-ghost/
├── tests/
│   ├── unit/
│   └── integration/
├── package.json
├── package-lock.json
└── README.md
```

### Migration steps

```bash
# 1. Create codeWS structure
mkdir -p ~/codeWS/JavaScript/ghost-pipeline/src
mkdir -p ~/codeWS/JavaScript/ghost-pipeline/tests/unit
mkdir -p ~/codeWS/JavaScript/ghost-pipeline/tests/integration

# 2. Move ghost.js into src/
cp ~/.openclaw/hooks/ghost.js ~/codeWS/JavaScript/ghost-pipeline/src/ghost.js
# (keep original as backup until symlink verified)

# 3. Symlink hook back
ln -sf ~/codeWS/JavaScript/ghost-pipeline/src/ghost.js ~/.openclaw/hooks/ghost.js

# 4. Symlink workspace (runtime data stays in place)
ln -sf ~/.openclaw/workspace-ghost ~/codeWS/JavaScript/ghost-pipeline/workspace

# 5. Init package.json
cd ~/codeWS/JavaScript/ghost-pipeline && npm init -y
npm install --save-dev jest nock

# 6. git init + initial commit
git init && git add . && git commit -m "feat: ghost pipeline v3 initial commit"
```

### Symlink verification
```bash
ls -la ~/.openclaw/hooks/ghost.js          # → should show symlink
node ~/.openclaw/hooks/ghost.js status     # → should still work
systemctl --user restart bluebubbles-webhook.service
```

### README.md should cover
- What Ghost is + what it does
- Architecture diagram (webhook → allowlist → draft → Discord → auto-send)
- Contact categories and how to add new contacts
- How to add to allowlist (CONTACTS.md format)
- Test suite usage
- Symlink paths and why
- Known limits (BlueBubbles delivery for PinePhone, MCP tunnel dependency)

---

## Acceptance Criteria

- [ ] Category tone injected into system prompts (verify via ghost learn --contact Mom output)
- [ ] `numToCategory` parsed correctly for all 9 contacts
- [ ] `isQuietHours` uses category, not hardcoded FAMILY_PHONES set
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] `~/.openclaw/hooks/ghost.js` is a symlink pointing to `~/codeWS/JavaScript/ghost-pipeline/src/ghost.js`
- [ ] `ghost.js status` works after migration
- [ ] Service restarts cleanly after migration
- [ ] README.md written and accurate

_Assign to: dev_
_Blocks: PLAN.md medium items (ISSUE-7 Ghost Agent tier ordering can be done alongside)_
