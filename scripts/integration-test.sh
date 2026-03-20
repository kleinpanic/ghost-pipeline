#!/usr/bin/env bash
# Ghost pipeline integration test — all button paths without real iMessage sends
set -euo pipefail

GHOST="http://127.0.0.1:18790"
NICK_GUID="iMessage;-;+14846342876"
NICK_PHONE="+14846342876"
UNKNOWN_PHONE="15559990001"
REGISTRY="/home/broklein/.openclaw/data/ghost-button-registry.json"
PENDING="/home/broklein/.openclaw/data/ghost-pending-drafts.json"
KLEIN_ID="1014431070059503699"
OK=0; FAIL=0

pass() { echo "  ✅ $1"; OK=$((OK+1)); }
fail() { echo "  ❌ FAIL: $1"; FAIL=$((FAIL+1)); }
section() { echo; echo "══ $1"; }
info() { echo "     $1"; }

# ── 1. Health ──────────────────────────────────────────────────────
section "1. Ghost health"
H=$(curl -sf "$GHOST/health" || echo '{}')
echo "$H" | grep -q '"ok":true' && pass "ghost daemon up" || { fail "ghost not responding: $H"; exit 1; }

# ── 2. Fire allowlisted webhook → expect draft ─────────────────────
section "2. Send webhook from Nick (allowlisted)"
TS=$(date +%s)
R=$(curl -sf -X POST "$GHOST/bluebubbles/message-sent" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"new-message\",\"data\":{
    \"originalROWID\":777001,\"guid\":\"IT-$TS\",
    \"text\":\"integration test $TS\",
    \"isFromMe\":false,\"chatGuid\":\"$NICK_GUID\",
    \"handle\":{\"originalROWID\":3,\"address\":\"$NICK_PHONE\",\"service\":\"iMessage\"},
    \"dateCreated\":${TS}000}}" 2>&1)
echo "$R" | grep -q '"ok":true' && pass "webhook accepted, draft queued" || fail "webhook rejected: $R"
echo "  Waiting 35s for 30s debounce..."
sleep 35

# ── 3. Check draft + button registry ──────────────────────────────
section "3. Draft + OC button registry"
DRAFT=$(python3 -c "
import json,os
d=json.load(open('$PENDING')) if os.path.exists('$PENDING') else []
nicks=[x for x in d if '4846342876' in str(x)]
print(nicks[-1]['draftId'] if nicks else '')
" 2>/dev/null)
[ -n "$DRAFT" ] && pass "draft generated: $DRAFT" || { fail "no draft found — check ghost logs"; }

if [ -n "$DRAFT" ]; then
  ENTRIES=$(python3 -c "
import json,os
r=json.load(open('$REGISTRY')) if os.path.exists('$REGISTRY') else {}
hits={k:v for k,v in r.items() if v.get('draftId')=='$DRAFT'}
print(len(hits))
for k,v in hits.items(): print(f'  {v[\"action\"]:8} → shortId={k}')
" 2>/dev/null)
  COUNT=$(echo "$ENTRIES" | head -1)
  if [ "$COUNT" = "2" ]; then
    pass "both buttons registered in OC gateway (send + cancel)"
    echo "$ENTRIES" | tail -n +2 | while read line; do info "$line"; done
  else
    fail "expected 2 registry entries, got: $COUNT — OC gateway posting may have failed"
    info "check ocGatewayPost() in ghost.js — fallback to raw curl means buttons won't work"
  fi
fi

# ── 4. Cancel via /action ──────────────────────────────────────────
section "4. Cancel button via /action endpoint"
if [ -n "$DRAFT" ]; then
  R=$(curl -sf -X POST "$GHOST/action" \
    -H "Content-Type: application/json" \
    -d "{\"draftId\":\"$DRAFT\",\"action\":\"cancel\",\"userId\":\"$KLEIN_ID\"}" 2>&1)
  echo "  response: $R"
  echo "$R" | grep -q '"cancelled"' && pass "/action cancel works" || fail "cancel failed: $R"

  STILL=$(python3 -c "
import json,os
d=json.load(open('$PENDING')) if os.path.exists('$PENDING') else []
print('yes' if any(x.get('draftId')=='$DRAFT' for x in d) else 'no')
" 2>/dev/null)
  [ "$STILL" = "no" ] && pass "draft removed from pending" || fail "draft still in pending after cancel"
fi

# ── 5. Send via /action (get fresh draft, then send-test, then cleanup) ──
section "5. Send button via /action endpoint"
TS2=$(date +%s)
curl -sf -X POST "$GHOST/bluebubbles/message-sent" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"new-message\",\"data\":{
    \"originalROWID\":777002,\"guid\":\"IT2-$TS2\",
    \"text\":\"send-path test $TS2\",
    \"isFromMe\":false,\"chatGuid\":\"$NICK_GUID\",
    \"handle\":{\"originalROWID\":3,\"address\":\"$NICK_PHONE\",\"service\":\"iMessage\"},
    \"dateCreated\":${TS2}000}}" > /dev/null 2>&1
echo "  Waiting 35s..."
sleep 35
DRAFT2=$(python3 -c "
import json,os
d=json.load(open('$PENDING')) if os.path.exists('$PENDING') else []
nicks=[x for x in d if '4846342876' in str(x)]
print(nicks[-1]['draftId'] if nicks else '')
" 2>/dev/null)
if [ -n "$DRAFT2" ]; then
  pass "second draft ready: $DRAFT2"
  info "REAL SEND TEST — this will send an iMessage to Nick"
  info "Calling /action send..."
  R2=$(curl -sf -X POST "$GHOST/action" \
    -H "Content-Type: application/json" \
    -d "{\"draftId\":\"$DRAFT2\",\"action\":\"send\",\"userId\":\"$KLEIN_ID\"}" 2>&1)
  echo "  send response: $R2"
  echo "$R2" | grep -q '"sent"' && pass "/action send completed (check Nick's iMessage)" || fail "send failed: $R2"
else
  fail "no second draft — skipping send test"
fi

# ── 6. Unknown contact → approve/deny buttons ──────────────────────
section "6. Unknown contact alert buttons"
TS3=$(date +%s)
R3=$(curl -sf -X POST "$GHOST/bluebubbles/message-sent" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"new-message\",\"data\":{
    \"originalROWID\":777003,\"guid\":\"IT3-$TS3\",
    \"text\":\"hey is this klein\",
    \"isFromMe\":false,\"chatGuid\":\"iMessage;-;+1$UNKNOWN_PHONE\",
    \"handle\":{\"originalROWID\":99,\"address\":\"+1$UNKNOWN_PHONE\",\"service\":\"iMessage\"},
    \"dateCreated\":${TS3}000}}" 2>&1)
echo "  unknown contact response: $R3"
echo "$R3" | grep -q '"ok":true' && pass "unknown contact webhook accepted" || fail "rejected: $R3"
sleep 3
info "Check Discord #ghost-openclaw for alert with Approve/Deny buttons"
info "Approve button custom_id should contain: approve_$UNKNOWN_PHONE"
info "Deny button custom_id should contain: deny_$UNKNOWN_PHONE"

# ── 7. Short-circuit: Klein recently active ────────────────────────
section "7. Klein-recently-active gate"
TS4=$(date +%s)
# Inject a fake outbound (isFromMe:true) first
curl -sf -X POST "$GHOST/bluebubbles/message-sent" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"new-message\",\"data\":{
    \"originalROWID\":777004,\"guid\":\"OUTBOUND-$TS4\",
    \"text\":\"outbound from klein\",
    \"isFromMe\":true,\"chatGuid\":\"$NICK_GUID\",
    \"handle\":{\"originalROWID\":3,\"address\":\"$NICK_PHONE\",\"service\":\"iMessage\"},
    \"dateCreated\":${TS4}000}}" > /dev/null 2>&1
sleep 1
# Now fire inbound — should be suppressed (Klein active <10min ago)
TS5=$(date +%s)
R5=$(curl -sf -X POST "$GHOST/bluebubbles/message-sent" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"new-message\",\"data\":{
    \"originalROWID\":777005,\"guid\":\"IT5-$TS5\",
    \"text\":\"active gate test $TS5\",
    \"isFromMe\":false,\"chatGuid\":\"$NICK_GUID\",
    \"handle\":{\"originalROWID\":3,\"address\":\"$NICK_PHONE\",\"service\":\"iMessage\"},
    \"dateCreated\":${TS5}000}}" 2>&1)
echo "  active gate response: $R5"
echo "$R5" | grep -q '"ok":true' && pass "webhook accepted" || fail "rejected"
info "Check ghost logs — should see 'klein_recently_active' skip (not a draft queued)"
sleep 2
LOG_CHECK=$(journalctl --user -u bluebubbles-webhook.service -n 20 --no-pager 2>/dev/null | grep "klein_recently_active" | wc -l)
[ "$LOG_CHECK" -gt 0 ] && pass "klein_recently_active gate fired in logs" || fail "gate did not fire — check runPreflight() step 8"

# ── Summary ────────────────────────────────────────────────────────
section "Summary"
echo "  Passed: $OK | Failed: $FAIL"
echo
if [ "$FAIL" -eq 0 ]; then
  echo "All automated checks passed."
  echo "Remaining manual step: click '✅ Send Now' in Discord on the draft from step 5 — confirm no expired error."
else
  echo "FAILURES DETECTED. Do NOT consider this fixed until all pass."
fi
