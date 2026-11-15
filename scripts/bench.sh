#!/bin/zsh
# Measures command latency against testpage/ through the Debug CLI: the median of each command's time in the app, of the CLI's wall time,
# and of each phase, over RUNS runs. wait is the delay from the text showing to the wait returning. Needs the Debug app (scripts/install.sh --debug)
# and the test page served (npm --prefix web run testpage). Run: scripts/bench.sh [RUNS] [click form_input key read_page find wait_look wait ...]
setopt pipe_fail
zmodload zsh/datetime

runs=${1:-15}
(($# > 0)) && shift
names=($@)
(($#names)) || names=(click form_input key read_page find wait_look wait)
results=$(mktemp -t safaripilot-bench)
opened=$(safaripilot tab-create http://127.0.0.1:8765/)
tab=$(print -r -- "$opened" | awk '/^opened tab/ {print $3; exit}')
[[ $tab == <-> ]] || { print "no tab: $opened"; exit 1 }
trap 'safaripilot tab-close $tab >/dev/null; rm -f $results' EXIT
sleep 1

ref() { safaripilot --tab $tab find "$1" --role $2 | sed -nE "s/^\[([0-9:]+)\] $2 \"$1\".*/\1/p" | head -1 }

button=$(ref Button button)
field=$(ref Text textbox)

# run NAME ARGS...: one timed CLI call, kept as a JSON line with its wall time.
run() {
  local name=$1 start=$EPOCHREALTIME reply
  shift
  reply=$(safaripilot --json --tab $tab "$@") || true
  print -r -- "$reply" | jq -c --arg name $name --argjson wall $(((EPOCHREALTIME - start) * 1000)) '{name: $name, wall: $wall, ok, timing}' >> $results
}

# The text shows 400 ms after the call that schedules it; the page keeps when, so the wait's delay is measured from the moment it showed.
waited() {
  local token="bench-$RANDOM-$1" start end shown ok
  safaripilot --tab $tab javascript "setTimeout(() => { document.body.append(Object.assign(document.createElement('p'), {textContent: '$token'})); window.benchShown = Date.now() }, 400); 0" >/dev/null
  start=$EPOCHREALTIME
  safaripilot --tab $tab wait --within 5 --text $token >/dev/null && ok=true || ok=false
  end=$EPOCHREALTIME
  shown=$(safaripilot --tab $tab javascript "window.benchShown")
  [[ $shown == <-> ]] || { ok=false; shown=$((end * 1000)) }
  jq -nc --argjson total $((end * 1000 - shown)) --argjson wall $(((end - start) * 1000)) --argjson ok $ok '{name: "wait", wall: $wall, ok: $ok, timing: {totalMs: $total, phases: []}}' >> $results
}

for name in $names; do
  for index in {1..$runs}; do
    case $name in
      click) run click click $button ;;
      form_input) run form_input form-input $field "bench $index" ;;
      key) run key key x --ref $field ;;
      read_page) run read_page read-page --all ;;
      find) run find find Button ;;
      wait_look) run wait_look wait-check --text "SafariPilot lab" ;;
      wait) waited $index ;;
    esac
  done
done

jq -rs '
  def median: sort | if length == 0 then 0 elif length % 2 == 1 then .[length / 2 | floor] else (.[length / 2 - 1] + .[length / 2]) / 2 end;
  def ms: . * 10 | round / 10;
  group_by(.name) | sort_by(.[0].name) | .[] | . as $runs
  | ([$runs[].timing.phases[]?.name] | unique) as $names
  | "\($runs[0].name): \([$runs[].timing.totalMs] | median | ms) ms in the app, \([$runs[].wall] | median | ms) ms wall, \($runs | map(select(.ok | not)) | length) failed of \($runs | length)",
    ($names[] as $phase | [$runs[] | ([.timing.phases[] | select(.name == $phase)] | first // {ms: 0, count: 0})] as $seen
      | "  \($phase) \([$seen[].count] | median)x \([$seen[].ms] | median | ms)")
' $results
