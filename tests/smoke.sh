#!/usr/bin/env bash
# tests/smoke.sh — end-to-end check of the taskmap CLI and server in a temp dir.
# Uses an isolated TASKMAP_HOME and its own port so it never touches ~/.taskmap.
# Exit 0 when every assertion passes.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TM="$HERE/bin/taskmap"
TMP="$(mktemp -d)"
export TASKMAP_HOME="$TMP/home"
export TASKMAP_PORT="${TASKMAP_PORT:-4747}"
unset TASKMAP_PROJECT
URL="http://127.0.0.1:$TASKMAP_PORT"
PASS=0
FAIL=0
WPID=""

cleanup() {
  "$TM" share --stop >/dev/null 2>&1 || true
  "$TM" serve --stop >/dev/null 2>&1 || true
  [ -n "$WPID" ] && kill "$WPID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() {
  FAIL=$((FAIL + 1))
  echo "FAIL $1"
  [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/     | /'
}
contains() { # label haystack needle
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1 (expected '$3')" "$2"; fi
}
not_contains() {
  if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1 (did not expect '$3')" "$2"; else ok "$1"; fi
}
equals() { # label actual expected
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', expected '$3')"; fi
}

# A fake browser, on PATH before anything runs: init and `open` launch one now.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/xdg-open" <<'XDG'
#!/bin/sh
echo "$1" >> "$XDG_LOG"
XDG
chmod +x "$TMP/bin/xdg-open"
export XDG_LOG="$TMP/opened.txt"
: > "$XDG_LOG"
export PATH="$TMP/bin:$PATH"

mkdir -p "$TMP/proj" && cd "$TMP/proj" && git init -q

# ---- init -------------------------------------------------------------
out=$("$TM" init "Pac-Man clone" --goal "A playable Pac-Man in the browser" 2>&1)
equals "init exits 0" "$?" "0"
contains "init prints root id and url" "$out" "n0  Pac-Man clone  $URL/p/"
contains "init writes .gitignore" "$(cat .gitignore)" ".taskmap/"
out=$("$TM" init "again" --goal "x" 2>&1)
equals "init is idempotent" "$?" "0"
contains "init again prints status" "$out" "0/0 leaves done"
[ -f .taskmap/map.json ] && ok "map.json exists" || bad "map.json missing"
[ -f .taskmap/log.jsonl ] && ok "log.jsonl exists" || bad "log.jsonl missing"

# ---- add --batch: 3 levels -------------------------------------------
out=$("$TM" add --batch 2>&1 <<'EOF'
[
 {"key":"m1","parent":"n0","title":"Build the maze","what":"Walls on a canvas.","why":"Everything moves inside it.","done_when":"The maze is visible."},
 {"key":"m2","parent":"n0","title":"Make the ghosts chase the player"},
 {"key":"c1","parent":"m1","title":"Decide the grid format"},
 {"key":"c2","parent":"m1","title":"Build the maze walls","links":["c1"],"done_when":"The player cannot cross a wall."},
 {"key":"s1","parent":"c2","title":"Draw the wall rectangles"}
]
EOF
)
equals "batch exits 0" "$?" "0"
contains "batch prints key -> id" "$out" "m1 -> n1"
contains "batch resolves keys in order" "$out" "s1 -> n5"

# ---- tree / next / show ----------------------------------------------
out=$("$TM" tree 2>&1)
contains "tree header" "$out" "Pac-Man clone  0/3 leaves done  0 in progress  0 blocked  0 unread"
contains "tree root line" "$out" "[ ] n0  Pac-Man clone  (0/3)"
contains "tree indents two spaces" "$out" "  [ ] n1  Build the maze  (0/2)"
contains "tree level 3" "$out" "      [ ] n5  Draw the wall rectangles"
out=$("$TM" next 2>&1)
contains "next picks first pending leaf" "$out" "n3  Decide the grid format"
out=$("$TM" show n4 2>&1)
contains "show prints links" "$out" "links: n3"
contains "show prints done_when" "$out" "done_when: The player cannot cross a wall."

# ---- status commands --------------------------------------------------
equals "start prints id" "$("$TM" start n3 2>/dev/null)" "n3"
contains "tree shows in_progress glyph" "$("$TM" tree)" "[~] n3"
contains "start also starts the parent" "$("$TM" tree)" "[~] n1  Build the maze"
equals "done prints id" "$("$TM" done n3 --note "grid is a text file" 2>/dev/null)" "n3"
contains "tree shows done glyph" "$("$TM" tree)" "[x] n3"
contains "next honours links" "$("$TM" next)" "n5  Draw the wall rectangles"
equals "block prints id" "$("$TM" block n5 --reason "waiting on user: wall color?" 2>/dev/null)" "n5"
contains "tree shows blocked reason" "$("$TM" tree)" "[!] n5  Draw the wall rectangles  blocked: waiting on user: wall color?"
contains "next skips blocked" "$("$TM" next)" "n2  Make the ghosts chase the player"
contains "status counts blocked" "$("$TM" status)" "blocked: 1"
contains "check counts blocked" "$("$TM" check)" "blocked: 1"
contains "check lists the question" "$("$TM" check)" "waiting: n5  Draw the wall rectangles  waiting on user: wall color?"
contains "check --json lists blocked" "$("$TM" check --json)" '"blocked":[{"id":"n5"' 
equals "skip prints id" "$("$TM" skip n2 --reason "ghosts come later" 2>/dev/null)" "n2"
contains "tree shows skipped" "$("$TM" tree)" "[-] n2  Make the ghosts chase the player  skipped: ghosts come later"
contains "next reports blocked" "$("$TM" next)" "none  remaining leaves are blocked: n5"
equals "reopen prints id" "$("$TM" reopen n5 2>/dev/null)" "n5"
contains "tree shows pending after reopen" "$("$TM" tree)" "[ ] n5  Draw the wall rectangles"
contains "skipped leaves leave the denominator" "$("$TM" tree)" "1/2 leaves done"
out=$("$TM" block n4 2>&1)
equals "block without reason exits 1" "$?" "1"
contains "block without reason hint" "$out" "needs --reason"

# ---- rejections -------------------------------------------------------
out=$("$TM" start n99 2>&1)
equals "unknown id exits 1" "$?" "1"
contains "unknown id message" "$out" "error: unknown node n99."
out=$("$TM" add "Too deep" --parent n5 2>&1)
equals "depth-4 add exits 1" "$?" "1"
contains "depth-4 message" "$out" "4 levels below the root; the limit is 3"
out=$("$TM" add "" --parent n0 2>&1)
equals "empty title exits 1" "$?" "1"
out=$("$TM" edit n1 --parent n4 2>&1)
equals "parent cycle exits 1" "$?" "1"
contains "cycle message" "$out" "cannot be its own ancestor"
out=$("$TM" add "One two three four five six seven eight nine" --parent n0 2>&1 >/dev/null)
contains "long title warns" "$out" "warn:"

# ---- server -----------------------------------------------------------
out=$("$TM" serve --ensure 2>&1)
contains "serve --ensure" "$out" "server"
out2=$("$TM" serve --ensure 2>&1)
contains "serve --ensure is idempotent" "$out2" "server running at $URL"
health=$(curl -s -m 2 "$URL/api/health")
contains "health" "$health" '"ok":true'
ID=$("$TM" check --json | sed -n 's/^{"map":true,"id":"\([^"]*\)".*/\1/p')
[ -n "$ID" ] && ok "check --json has id ($ID)" || bad "check --json has no id"
contains "api projects lists it" "$(curl -s "$URL/api/projects")" "\"id\":\"$ID\""
full=$(curl -s "$URL/api/projects/$ID")
contains "api full map" "$full" '"schema":1'
contains "api log tail" "$full" '"type":"init"'

# SSE: a map event within 1 s of a CLI change
SSE="$TMP/sse.txt"
curl -s -N --max-time 5 "$URL/api/projects/$ID/events" >"$SSE" 2>/dev/null &
SSE1=$!
sleep 0.7
"$TM" note n4 "walls are 32px tall" >/dev/null 2>&1
for _ in $(seq 1 20); do
  [ "$(grep -c '"type":"map"' "$SSE" 2>/dev/null)" -ge 2 ] && break
  sleep 0.05
done
n=$(grep -c '"type":"map"' "$SSE" 2>/dev/null)
[ "${n:-0}" -ge 2 ] && ok "SSE delivers a map event within 1 s of a CLI change" || bad "SSE map events: ${n:-0}"
kill $SSE1 2>/dev/null; wait $SSE1 2>/dev/null

# feedback round trip: curl POST -> inbox
r=$(curl -s -X POST "$URL/api/projects/$ID/feedback" -H 'content-type: application/json' -d '{"node":"n4","text":"walls should be half as tall"}')
contains "feedback POST ok" "$r" '"ok":true'
contains "tree shows unread" "$("$TM" tree)" "n4  Build the maze walls  (0/1)  (1 unread)"
out=$("$TM" inbox 2>&1)
contains "inbox prints feedback" "$out" 'n4 "Build the maze walls": walls should be half as tall'
equals "inbox empties" "$("$TM" inbox)" "inbox empty"
r=$(curl -s -X POST "$URL/api/projects/$ID/nodes" -H 'content-type: application/json' -d '{"parent":"n0","title":"Add a start screen"}')
contains "user node POST" "$r" '"id":"n7"'
contains "tree marks user node" "$("$TM" tree)" "n7  Add a start screen *  (1 unread)"
contains "inbox prints user node" "$("$TM" inbox)" 'n7 "Add a start screen" added by user under n0'
r=$(curl -s -X POST "$URL/api/projects/$ID/nodes/n3/status" -H 'content-type: application/json' -d '{"status":"pending"}')
contains "status override POST" "$r" '"status":"pending"'
contains "inbox prints override" "$("$TM" inbox)" 'n3 "Decide the grid format" set to pending by user'
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/api/projects/$ID/feedback" -d 'nope')
equals "bad JSON is 400" "$code" "400"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/api/projects/$ID/feedback" -H 'content-type: application/json' -d '{"node":"n99","text":"x"}')
equals "unknown node is 404" "$code" "404"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/api/projects/$ID/nodes/n3/status" -H 'content-type: application/json' -d '{"status":"weird"}')
equals "unknown status is 400" "$code" "400"
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/projects/nope")
equals "unknown project is 404" "$code" "404"
contains "ui index served" "$(curl -s "$URL/")" "<html"

# ---- pages: overview at /, project at /p/<id>, old ?p= redirects ------
contains "overview page at /" "$(curl -s "$URL/")" 'src="/overview.js"'
contains "project page at /p/<id>" "$(curl -s "$URL/p/$ID")" 'src="/app.js"'
loc=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$URL/?p=$ID")
equals "old ?p= link redirects" "$loc" "302 $URL/p/$ID"

# ---- /api/clients and session heartbeats ------------------------------
wait_clients() { # wait_clients <n>
  for _ in $(seq 1 40); do
    [ "$(curl -s "$URL/api/clients" | sed -n 's/.*"total":\([0-9]*\).*/\1/p')" = "$1" ] && return 0
    sleep 0.1
  done
  return 1
}
wait_clients 0 || bad "clients did not settle to 0" "$(curl -s "$URL/api/clients")"
c=$(curl -s "$URL/api/clients")
contains "clients is ok" "$c" '"ok":true'
contains "clients reports a total" "$c" '"total":0'
contains "clients reports sessions" "$c" '"sessions":{}'
SSE2="$TMP/sse2.txt"
curl -s -N --max-time 4 "$URL/api/projects/$ID/events" >"$SSE2" 2>/dev/null &
SSEPID=$!
wait_clients 1 || true
c=$(curl -s "$URL/api/clients")
contains "clients counts an SSE listener" "$c" "\"$ID\":1"
contains "clients totals it" "$c" '"total":1'
contains "projects reports the client count" "$(curl -s "$URL/api/projects")" '"clients":1'

# open --if-needed does not open while a browser is watching
out=$("$TM" open --if-needed 2>&1)
contains "open --if-needed skips a watched project" "$out" "already open in a browser"
kill $SSEPID 2>/dev/null; wait $SSEPID 2>/dev/null
wait_clients 0 || true
equals "clients drops to 0 when the listener leaves" "$(curl -s "$URL/api/clients" | sed -n 's/.*"total":\([0-9]*\).*/\1/p')" "0"

# a fresh heartbeat is live, a 90 s old one is not (and is pruned)
node -e '
const store = require(process.argv[1]);
store.writeSession({ pid: 424242, project_id: process.argv[2], cwd: "/tmp" });
' "$HERE/src/store.js" "$ID"
contains "a fresh heartbeat is live" "$(curl -s "$URL/api/clients")" "\"sessions\":{\"$ID\":1}"
contains "projects shows the live dot" "$(curl -s "$URL/api/projects")" '"live":true'
node -e '
const fs = require("fs"), path = require("path");
const store = require(process.argv[1]);
const f = store.sessionFile(424242);
const old = new Date(Date.now() - 90000).toISOString();
const rec = JSON.parse(fs.readFileSync(f, "utf8"));
fs.writeFileSync(f, JSON.stringify({ ...rec, last_seen: old }));
' "$HERE/src/store.js"
contains "a 90 s old heartbeat is not live" "$(curl -s "$URL/api/clients")" '"sessions":{}'
contains "projects drops the live dot" "$(curl -s "$URL/api/projects")" '"live":false'
[ -e "$TASKMAP_HOME/sessions/424242.json" ] && bad "stale heartbeat not pruned" || ok "stale heartbeat is pruned"

# ---- open --if-needed opens once per session --------------------------
contains "init opened the dashboard once" "$(cat "$XDG_LOG")" "$URL/p/$ID"
equals "init opened exactly one tab" "$(wc -l < "$XDG_LOG" | tr -d ' ')" "1"
: > "$XDG_LOG"
node -e '
const store = require(process.argv[1]);
store.writeSession({ pid: 424243, project_id: process.argv[2], cwd: process.argv[3] });
' "$HERE/src/store.js" "$ID" "$PWD"
out=$("$TM" open --if-needed 2>&1)
contains "open --if-needed opens the project page" "$out" "$URL/p/$ID"
not_contains "open --if-needed opened it for real" "$out" "already"
out=$("$TM" open --if-needed 2>&1)
contains "open --if-needed will not open a second tab" "$out" "already opened this session"
"$TM" open --if-needed >/dev/null 2>&1
equals "browser launched exactly once" "$(wc -l < "$XDG_LOG" | tr -d ' ')" "1"
"$TM" open >/dev/null 2>&1
equals "plain open always opens" "$(wc -l < "$XDG_LOG" | tr -d ' ')" "2"
node -e '
const store = require(process.argv[1]);
store.removeSession(424243);
' "$HERE/src/store.js"

# ---- share: token guard, tunnel lifecycle, QR -------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: elsewhere.example.com" "$URL/api/health")
equals "no share: any Host is served" "$code" "200"

# A stand-in for cloudflared: the real one would open a public tunnel.
cat > "$TMP/bin/cloudflared" <<'CF'
#!/bin/sh
echo "INF +--------------------------------------------------------+"
echo "INF |  https://smoke-test-tunnel.trycloudflare.com            |"
echo "INF Registered tunnel connection"
while true; do sleep 1; done
CF
chmod +x "$TMP/bin/cloudflared"

out=$("$TM" share 2>&1)
contains "share prints the tunnel link" "$out" "https://smoke-test-tunnel.trycloudflare.com/?t="
TOKEN=$(printf '%s\n' "$out" | sed -n 's|.*trycloudflare.com/?t=\([A-Za-z0-9_-][A-Za-z0-9_-]*\).*|\1|p' | head -1)
equals "the token is 32 bytes of base64url" "${#TOKEN}" "43"
[ -f "$TASKMAP_HOME/share.json" ] && ok "share.json exists while sharing" || bad "share.json missing"
qrlines=$(printf '%s\n' "$out" | grep -c '[█▀▄]')
[ "${qrlines:-0}" -ge 15 ] && ok "share draws a QR code ($qrlines rows)" || bad "QR rows: ${qrlines:-0}"

FOREIGN=(-H "Host: smoke-test-tunnel.trycloudflare.com" -H "X-Forwarded-Proto: https")
code=$(curl -s -o /dev/null -w '%{http_code}' "${FOREIGN[@]}" "$URL/")
equals "a foreign Host without the token is 401" "$code" "401"
body=$(curl -s "${FOREIGN[@]}" "$URL/")
equals "the 401 body is empty" "${#body}" "0"
code=$(curl -s -o /dev/null -w '%{http_code}' "${FOREIGN[@]}" "$URL/api/projects")
equals "the API is guarded too" "$code" "401"
code=$(curl -s -o /dev/null -w '%{http_code}' "${FOREIGN[@]}" "$URL/?t=wrong-token-entirely")
equals "a wrong token is 401" "$code" "401"
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/")
equals "localhost still needs no token" "$code" "200"

# ?t= on first load -> HttpOnly cookie -> the token leaves the address bar.
# The round trip runs without X-Forwarded-Proto, because curl will not send a
# Secure cookie back over plain http; the Secure attribute is asserted separately.
PLAIN=(-H "Host: smoke-test-tunnel.trycloudflare.com")
JAR="$TMP/cookies.txt"
hdr=$(curl -s -o /dev/null -D - -c "$JAR" "${PLAIN[@]}" "$URL/?t=$TOKEN")
contains "the token redirects" "$hdr" "302"
contains "the redirect strips the token" "$hdr" "Location: /"
not_contains "the redirect keeps no t= behind" "$hdr" "Location: /?t="
contains "the cookie is HttpOnly" "$hdr" "HttpOnly"
contains "the cookie is SameSite" "$hdr" "SameSite=Lax"
contains "the cookie is Secure behind https" "$(curl -s -o /dev/null -D - "${FOREIGN[@]}" "$URL/?t=$TOKEN")" "; Secure"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "${PLAIN[@]}" "$URL/")
equals "the cookie alone is enough afterwards" "$code" "200"
contains "and it serves the overview" "$(curl -s -b "$JAR" "${PLAIN[@]}" "$URL/")" 'src="/overview.js"'
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "${PLAIN[@]}" "$URL/api/projects")
equals "the cookie reaches the API" "$code" "200"

out=$("$TM" share 2>&1)
contains "share is idempotent" "$out" "https://smoke-test-tunnel.trycloudflare.com/?t=$TOKEN"
out=$("$TM" share --stop 2>&1)
contains "share --stop reports it" "$out" "no longer works"
[ -f "$TASKMAP_HOME/share.json" ] && bad "share.json survived --stop" || ok "share --stop deletes the token"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "${PLAIN[@]}" "$URL/")
equals "the old cookie is meaningless once stopped" "$code" "200"
equals "share --stop twice is harmless" "$("$TM" share --stop)" "no share running"
rm -f "$TMP/bin/cloudflared"
out=$("$TM" share 2>&1); rc=$?
equals "share without cloudflared exits 1" "$rc" "1"
contains "share says how to install cloudflared" "$out" "cloudflared is not installed"

# the QR encoder, checked against an independent decoder when one is available
qrout=$(python3 "$HERE/tests/qr-verify.py" 2>&1); qrc=$?
if printf '%s' "$qrout" | grep -q '^skip'; then
  ok "qr-verify skipped (no independent decoder here)"
else
  equals "every QR version decodes independently" "$qrc" "0"
  not_contains "no QR failed to decode" "$qrout" "FAIL"
  contains "qr-verify covered the whole version range" "$qrout" "v10-L"
fi

# ---- check ------------------------------------------------------------
out=$("$TM" check 2>&1)
equals "check exits 0" "$?" "0"
contains "check prints unread" "$out" "unread: 0"
"$TM" start n5 >/dev/null 2>&1
contains "check lists in_progress" "$("$TM" check)" "in_progress: n5  Draw the wall rectangles  (leaf)"
"$TM" reopen n5 >/dev/null 2>&1

# ---- watch ------------------------------------------------------------
W="$TMP/watch.txt"
"$TM" watch >"$W" 2>&1 &
WPID=$!
sleep 1.2
echo '{"ts":"2026-01-01T00:00:00.000Z","actor":"ui","type":"feedback","node":"n4","title":"Build the maze walls","text":"make them thicker"}' >>.taskmap/inbox.jsonl
sleep 1.5
kill "$WPID" 2>/dev/null
wait "$WPID" 2>/dev/null
WPID=""
equals "watch prints exactly one line" "$(wc -l <"$W" | tr -d ' ')" "1"
equals "watch line format" "$(cat "$W")" '[taskmap] feedback on n4 "Build the maze walls": make them thicker'

# ---- hooks ------------------------------------------------------------
hook() { # name json
  printf '%s' "$2" | "$TM" hook "$1" 2>/dev/null
}
contains "session-start prints the summary" "$(hook session-start "{\"source\":\"startup\",\"cwd\":\"$PWD\"}")" "[taskmap] Map found: Pac-Man clone, 0/4 done, 0 in progress, 0 blocked, 0 unread. Run /taskmap to resume."
out=$(hook session-start "{\"source\":\"compact\",\"cwd\":\"$PWD\"}")
contains "compact re-injects the tree" "$out" "[~] n1  Build the maze"
contains "compact keeps the indentation" "$out" "      [ ] n5  Draw the wall rectangles"
contains "compact names the map" "$out" "[taskmap] Context was compacted."
equals "session-start is silent without a map" "$(cd "$TMP" && hook session-start "{\"source\":\"startup\",\"cwd\":\"$TMP\"}")" ""
"$TM" start n5 >/dev/null 2>&1
contains "stop blocks on an open leaf" "$(hook stop "{\"stop_hook_active\":false,\"cwd\":\"$PWD\"}")" '"decision":"block"'
equals "stop allows the second time" "$(hook stop "{\"stop_hook_active\":true,\"cwd\":\"$PWD\"}")" ""
contains "without a task list, stop says to leave agents' steps alone" "$(hook stop "{\"stop_hook_active\":false,\"cwd\":\"$PWD\"}")" 'background agent is still working on stays in progress'
equals "stop lets the lead wait on background agents" "$(hook stop "{\"stop_hook_active\":false,\"cwd\":\"$PWD\",\"background_tasks\":[{\"id\":\"a1\",\"type\":\"subagent\",\"status\":\"running\"}]}")" ""
out=$(hook stop "{\"stop_hook_active\":false,\"cwd\":\"$PWD\",\"background_tasks\":[{\"id\":\"b1\",\"type\":\"shell\",\"status\":\"running\"}]}")
contains "a background shell is not an agent: stop still blocks" "$out" '"decision":"block"'
not_contains "with a task list and no agents, no agent clause" "$out" 'background agent'
"$TM" reopen n5 >/dev/null 2>&1
equals "stop allows with nothing open" "$(hook stop "{\"stop_hook_active\":false,\"cwd\":\"$PWD\"}")" ""
long=$(printf 'x%.0s' $(seq 1 450))
equals "prompt reminder is off by default" "$(hook prompt "{\"prompt\":\"$long\",\"cwd\":\"$PWD\"}")" ""
"$TM" config prompt-reminder on >/dev/null 2>&1
contains "prompt reminder fires on a long prompt" "$(hook prompt "{\"prompt\":\"$long\",\"cwd\":\"$PWD\"}")" "[taskmap] Long prompt"
equals "prompt reminder skips short prompts" "$(hook prompt "{\"prompt\":\"short\",\"cwd\":\"$PWD\"}")" ""
"$TM" start n5 >/dev/null 2>&1
equals "prompt reminder skips when a leaf is in progress" "$(hook prompt "{\"prompt\":\"$long\",\"cwd\":\"$PWD\"}")" ""
"$TM" reopen n5 >/dev/null 2>&1
"$TM" config prompt-reminder off >/dev/null 2>&1

# ---- export -----------------------------------------------------------
out=$("$TM" export --obsidian "$TMP/vault" 2>&1)
equals "export exits 0" "$?" "0"
contains "export reports the count" "$out" "notes -> $TMP/vault"
[ -f "$TMP/vault/n4 Build the maze walls.md" ] && ok "export writes a note per node" || bad "export note missing" "$(ls "$TMP/vault")"
note=$(cat "$TMP/vault/n4 Build the maze walls.md")
contains "export links the parent" "$note" "**Parent:** [[n1 Build the maze]]"
contains "export links dependencies" "$note" "**Depends on:** [[n3 Decide the grid format]]"
contains "export has frontmatter" "$note" "status: in_progress"

# ---- lock contention --------------------------------------------------
for i in $(seq 1 20); do "$TM" note n0 "concurrent note $i" >/dev/null 2>&1 & done
wait
count=$(node -e 'const m=require(process.argv[1]);console.log(m.nodes.n0.notes.length)' "$PWD/.taskmap/map.json" 2>/dev/null)
equals "20 concurrent notes all land" "$count" "20"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$PWD/.taskmap/map.json" && ok "map.json is valid JSON" || bad "map.json corrupt"
[ -e .taskmap/map.lock ] && bad "lock file left behind" || ok "no lock file left behind"
equals "no temp files left" "$(ls -A .taskmap | grep -c '\.tmp$')" "0"

# ---- prompt runs: the dashboard's progress bar and ETA, at no token cost ----
SID=$(node -e 'console.log(require(process.argv[1]).sidOf("S-1"))' "$HERE/src/runs.js")
equals "prompt hook prints nothing" "$(hook prompt "{\"session_id\":\"S-1\",\"prompt\":\"Add the  ghosts\",\"cwd\":\"$PWD\"}")" ""
runs=$(cat .taskmap/runs.json)
contains "a prompt opens a run" "$runs" '"prompt": "Add the ghosts"'
contains "the run belongs to the session" "$runs" "\"sid\": \"$SID\""
new=$(CLAUDE_CODE_SESSION_ID=S-1 "$TM" add "Chase the player" --parent n1 2>/dev/null)
contains "a node added in the prompt carries its session" "$("$TM" show "$new" >/dev/null; node -e 'const m=require(process.argv[1]);console.log(JSON.stringify(m.nodes[process.argv[2]]))' "$PWD/.taskmap/map.json" "$new")" "\"sid\":\"$SID\""
sleep 0.5
api=$(curl -s "$URL/api/projects/$ID")
contains "the API sends the prompt's progress" "$api" '"prompt":"Add the ghosts","follow_ups":0'
contains "a new request counts only its own steps" "$api" '"state":"running","steps":1'
contains "the overview carries it too" "$(curl -s "$URL/api/projects")" '"prompt":"Add the ghosts","follow_ups":0'
equals "stop hook prints nothing" "$(hook stop "{\"session_id\":\"S-1\",\"stop_hook_active\":false,\"cwd\":\"$PWD\"}")" ""
not_contains "stop ends the run" "$(node -e 'const d=require(process.argv[1]);console.log(JSON.stringify(d.runs.filter((r)=>r.sid===process.argv[2])))' "$PWD/.taskmap/runs.json" "$SID")" '"ended":null'
[ -f "$TASKMAP_HOME/prompts/$SID.json" ] && ok "the session's prompt record exists" || bad "prompt record missing"
hook prompt "{\"session_id\":\"S-1\",\"prompt\":\"Send agents after the ghosts\",\"cwd\":\"$PWD\"}" >/dev/null
equals "stop with agents out prints nothing" "$(hook stop "{\"session_id\":\"S-1\",\"stop_hook_active\":false,\"cwd\":\"$PWD\",\"background_tasks\":[{\"id\":\"a1\",\"type\":\"subagent\",\"status\":\"running\"},{\"id\":\"a2\",\"type\":\"subagent\",\"status\":\"running\"}]}")" ""
contains "the run waits on its agents instead of ending" "$(node -e 'const d=require(process.argv[1]);console.log(JSON.stringify(d.runs.filter((r)=>r.sid===process.argv[2]).pop()))' "$PWD/.taskmap/runs.json" "$SID")" '"ended":null,"open":'
sleep 0.5
contains "the API keeps it running with its agents" "$(curl -s "$URL/api/projects/$ID")" '"agents":2'
equals "eta records the prompt's estimate" "$(CLAUDE_CODE_SESSION_ID=S-1 "$TM" eta 1h30 2>&1)" "eta 1h30"
sleep 0.5
contains "the API carries the estimate" "$(curl -s "$URL/api/projects/$ID")" '"estimate_ms":5400000'
contains "eta rejects a non-duration" "$(CLAUDE_CODE_SESSION_ID=S-1 "$TM" eta soon 2>&1)" "eta needs a duration like 15m"
contains "eta needs a running prompt" "$(CLAUDE_CODE_SESSION_ID=S-9 "$TM" eta 10m 2>&1)" "no prompt is running here"
equals "add --eta sets it with the plan" "$(printf '[{"key":"x","parent":"n0","title":"Scare the ghosts"}]' | CLAUDE_CODE_SESSION_ID=S-1 "$TM" add --batch --eta 20 2>&1 | tail -1)" "eta 20min"

# ---- wrap up ----------------------------------------------------------
echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
