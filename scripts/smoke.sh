#!/bin/zsh
# Live smoke test against real sites through the installed CLI; prints PASS or FAIL per check and exits nonzero on any failure.
# Sites change, so a failure means look, not necessarily a regression. Run: scripts/smoke.sh [site ...]
# Needs the Debug app (scripts/install.sh --debug): Release builds run only mcp and status.
# The mcp site drives `safaripilot mcp` over stdio and needs approval: export a trusted SAFARIPILOT_CREDENTIAL, or approve the dialog when it appears.
setopt pipe_fail
failures=0
tab=""
# The last checked command's output.
output=""

open_tab() {
  tab=$(safaripilot tab-create "$1" | awk '{print $3}')
  sleep 2
}

close_tab() { [[ -n $tab ]] && safaripilot tab-close $tab >/dev/null; tab="" }

# verdict LABEL PATTERN: greps the last output for PATTERN.
verdict() {
  if print -r -- "$output" | grep -qE -- "$2"; then
    print "PASS $1"
    return
  fi

  print "FAIL $1\n$(print -r -- "$output" | head -8 | sed 's/^/    /')"
  failures=$((failures + 1))
}

# check LABEL PATTERN COMMAND...: runs the CLI command on the current tab and greps its output for PATTERN.
check() {
  local label=$1 pattern=$2
  shift 2
  output=$(safaripilot --timeout 30 --tab $tab "$@" 2>&1)
  verdict $label $pattern
}

# refute LABEL PATTERN: passes when the last output does not match PATTERN.
refute() {
  if ! print -r -- "$output" | grep -qE -- "$2"; then
    print "PASS $1"
    return
  fi

  print "FAIL $1\n    $(print -r -- "$output" | grep -E -- "$2" | head -1)"
  failures=$((failures + 1))
}

# ref NAME [ROLE]: the first ref find returns.
ref() { safaripilot --tab $tab find "$1" ${2:+--role} ${2:+$2} | head -1 | sed -nE 's/^\[([0-9:]+)\].*/\1/p' }

site_wikipedia() {
  open_tab "https://en.wikipedia.org/wiki/Usage_share_of_web_browsers"
  check "wikipedia: logo link named from its images" 'link "Wikipedia The Free Encyclopedia"' read-page --max-chars 800
  check "wikipedia: table named by caption" 'table "Usage share of mobile browsers"' find --role table
  check "wikipedia: javascript sees page globals" '^"object"$' javascript "typeof mw"
  check "wikipedia: javascript awaits and returns JSON" '^\{"answer":42\}$' javascript "let answer = await new Promise((resolve) => setTimeout(() => resolve(6 * 7), 50)); ({ answer })"
  check "wikipedia: javascript throws fail" 'the code threw Error: boom' javascript "throw new Error('boom')"
  close_tab
}

site_hackernews() {
  open_tab "https://news.ycombinator.com/"
  check "hn: upvote link named by title" 'link "upvote"' read-page --all --max-chars 3000
  check "hn: cells show text as children, not names" '^ +cell \[ref' read-page --all --max-chars 3000
  close_tab
}

site_github() {
  open_tab "https://github.com/WebKit/WebKit/pulls"
  local search=$(ref "Search pull requests" combobox)
  check "github: react search field set" '\(matches\)' form-input $search "is:pr accessibility"
  check "github: enter searches" 'keydowns reached|navigated' key Enter --ref $search
  sleep 3
  check "github: results listed" 'link "AX' find "AX" --role link
  check "github: javascript refused by the page CSP" "Content-Security-Policy" javascript "1"
  close_tab
}

site_mdn() {
  open_tab "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details"
  check "mdn: svg title names the logo link" 'link "MDN"' read-page --max-chars 600
  local summary=$(ref "Baseline" button)
  check "mdn: summary toggles with click" 'toggled summary' click $summary
  close_tab
  open_tab "https://developer.mozilla.org/en-US/play"
  check "mdn: editor roots are textboxes" '^\[[0-9]+\] textbox <div>' find --role textbox
  (($(print -r -- "$output" | grep -c textbox) == 3)) && print "PASS mdn: only the 3 editor roots" || { print "FAIL mdn: only the 3 editor roots"; failures=$((failures + 1)) }
  check "mdn: editor takes keys" 'keydowns reached' key --ref $(ref "" textbox) --text "<p>x"
  close_tab
}

site_httpbin() {
  open_tab "https://httpbin.org/forms/post"
  check "httpbin: labels not repeated, fieldset named" 'group "Pizza Size"' read-page --all --max-chars 1500
  check "httpbin: text field" '\(matches\)' form-input $(ref "Customer" textbox) "Ada"
  check "httpbin: key after form-input keeps focus" 'last on \[[0-9]+\] input' key --text "X"
  check "httpbin: radio" 'checked radio' form-input $(ref "Medium" radio) true
  check "httpbin: time field" '\(matches\)' form-input $(ref "delivery time" textbox) "19:30"
  check "httpbin: submit" 'click on|navigated' click $(ref "Submit order" button)
  sleep 2
  check "httpbin: posted values" '"custname": "AdaX"' text
  close_tab
}

site_network() {
  open_tab "https://httpbin.org/html"
  check "network: the page load is logged" 'GET https://httpbin.org/html main_frame: 200' network
  check "network: a page fetch returns" '^200$' javascript "(await fetch('/anything?api_key=k', {method: 'POST', headers: {'X-Api-Key': 'k'}, body: JSON.stringify({token: 'abc', n: 1})})).status"
  check "network: the fetch is logged with its key hidden" 'POST https://httpbin.org/anything\?api_key=\[hidden\]' network --pattern /anything
  local id=$(print -r -- "$output" | sed -nE 's/.* id ([0-9]+) POST .*/\1/p' | tail -1)
  check "network: secret request header hidden" '[Xx]-[Aa]pi-[Kk]ey: \[hidden\]' network --id ${id:-0}
  verdict "network: request body read and redacted" '"token":"\[hidden\]"'
  verdict "network: response body read" '^Response body \(application/json\)'
  refute "network: no secret in headers or bodies" 'abc|api_key=k|Api-Key": "k'
  close_tab
}

site_youtube() {
  open_tab "https://www.youtube.com/"
  local search=$(ref "Search" combobox)
  check "youtube: search field set despite role change" '\(matches\)' form-input $search "safari technology preview"
  check "youtube: enter searches" 'keydowns reached|navigated' key Enter --ref $search
  close_tab
}

site_osm() {
  open_tab "https://www.openstreetmap.org/"
  check "osm: leaflet zoom link in an overflowed pane" 'click on' click $(ref "Zoom In" link)
  close_tab
}

site_npm() {
  open_tab "https://www.npmjs.com/"
  local search=$(ref "Search packages" combobox)
  check "npm: search field" '\(matches\)' form-input $search vitest
  check "npm: covered field still takes keys" 'keydowns reached|navigated' key Enter --ref $search
  close_tab
}

site_apple() {
  open_tab "https://www.apple.com/"
  local menu=$(ref "Mac menu" button)
  check "apple: covered menu button refused with a hint" 'key Enter or Space' click $menu
  check "apple: menu opens from the keyboard" 'keydowns reached' key Enter --ref $menu
  close_tab
}

site_w3schools() {
  open_tab "https://www.w3schools.com/howto/howto_js_rangeslider.asp"
  check "w3schools: slider set" 'read back: "30" \(matches\)' form-input $(ref "" slider) 30
  close_tab
  open_tab "https://www.w3schools.com/tags/att_a_target.asp"
  check "w3schools: target=_blank link clicked" 'click on' click $(ref "Try it Yourself" link)
  sleep 2
  local popup=$(safaripilot tabs | awk '/tryit.asp/ {print $2; exit}')
  [[ -n $popup ]] && print "PASS w3schools: popup opened" || { print "FAIL w3schools: popup opened"; failures=$((failures + 1)) }
  [[ -n $popup ]] && safaripilot tab-close $popup >/dev/null
  close_tab
  open_tab "https://www.w3schools.com/js/tryit.asp?filename=tryjs_confirm"
  check "w3schools: click names the confirm it opened" 'opened a confirm from https://www.w3schools.com' click $(ref "Try it" button)
  check "w3schools: page tools name the open dialog" 'shows a confirm' text
  check "w3schools: dialog dismissed" 'dismissed a confirm' dialog dismiss
  check "w3schools: page saw Cancel" '^You pressed Cancel!$' text
  close_tab
}

site_bbc() {
  open_tab "https://www.bbc.com/news"
  check "bbc: block children spaced in link names" 'link "[^"]*[a-z] [A-Z]' find "" --role link
  close_tab
}

site_discourse() {
  open_tab "https://meta.discourse.org/latest"
  safaripilot --tab $tab scroll down 25 >/dev/null
  sleep 2
  check "discourse: find after scrolling lists on-screen links" '^\[[0-9]+\] link' find --role link
  refute "discourse: no offscreen links crowd the cap" offscreen
  close_tab
}

site_frames() {
  open_tab "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button"
  check "frames: live sample inlined" '\[ref=[0-9]+:[0-9]+\]' read-page --max-chars 20000
  check "frames: cross-origin button clicked" 'click on \[[0-9]+:[0-9]+\]' click $(ref "Add to favorites" button)
  check "frames: frame text in page text" '\[frame [0-9]+ [^]]*mdnplay.dev\]' text
  check "frames: javascript in a frame" 'mdnplay.dev' javascript --frame $(ref "" iframe) "location.hostname"
  close_tab
  open_tab "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/text"
  local field=$(ref "Name (4 to 8 characters)" textbox)
  check "frames: form-input in frame" '\(matches\)' form-input $field "abcd"
  check "frames: keys counted in frame" 'keydowns reached' key --ref $field --text "ef"
  close_tab
  open_tab "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/color"
  local well=$(ref "Foreground color" button)
  # A frame logs nothing before its first events read.
  safaripilot --tab $tab events --clear >/dev/null
  check "frames: color input set by name" 'read back: "#008000"' form-input $well green
  check "frames: color change logged" 'change UNTRUSTED' events
  close_tab
  open_tab "https://www.w3schools.com/jsref/tryit.asp?filename=tryjsref_onclick"
  check "frames: tryit result button" 'click on \[[0-9]+:[0-9]+\]' click $(ref "Click me" button)
  close_tab
}

site_reddit() {
  open_tab "https://www.reddit.com/r/swift/"
  check "reddit: closed sort menu stays out" '^no matches' find "Rising"
  check "reddit: sort menu opens" 'click on' click $(ref "Sort by" button)
  sleep 1
  check "reddit: items of a menu in a visibility:hidden list" 'link "Rising"' find "Rising"
  close_tab
}

site_facebook() {
  open_tab "https://www.facebook.com/"
  sleep 2
  check "facebook: self-XSS warning read from the console" 'facebook.com/selfxss' console --pattern selfxss
  check "facebook: only errors leaves the warning out" '^No matching console messages\.$' console --errors --pattern selfxss
  close_tab
}

site_theinternet() {
  local base="https://the-internet.herokuapp.com"
  open_tab "$base/dropdown"
  check "the-internet: select option by label" 'selected "Option 2"' form-input $(ref "" combobox) "Option 2"
  check "the-internet: select value read back" '^"2"$' javascript "document.querySelector('select').value"
  check "the-internet: navigate" 'loaded tab' navigate "$base/checkboxes"
  check "the-internet: checkbox" 'checked checkbox' form-input $(ref "" checkbox) true
  check "the-internet: both boxes checked" '^\[true,true\]$' javascript "[...document.querySelectorAll('input[type=checkbox]')].map((box) => box.checked)"
  check "the-internet: navigate back" '/dropdown' navigate back
  safaripilot --tab $tab navigate "$base/javascript_alerts" >/dev/null
  check "the-internet: alert opened" 'opened an alert' click $(ref "JS Alert" button)
  check "the-internet: alert accepted" 'accepted an alert' dialog accept
  check "the-internet: page saw the alert close" '^You successfully clicked an alert$' text
  check "the-internet: confirm opened" 'opened a confirm' click $(ref "JS Confirm" button)
  check "the-internet: confirm accepted" 'accepted a confirm' dialog accept
  check "the-internet: page saw OK" '^You clicked: Ok$' text
  check "the-internet: prompt opened" 'opened a prompt' click $(ref "JS Prompt" button)
  check "the-internet: prompt answered" 'typed 5 characters' dialog accept --text pilot
  check "the-internet: page saw the prompt text" '^You entered: pilot$' text
  safaripilot --tab $tab navigate "$base/shadowdom" >/dev/null
  check "the-internet: slotted text read through shadow roots" '^In a list!$' text
  refute "the-internet: replaced slot defaults left out" 'My default text'
  safaripilot --tab $tab navigate "$base/upload" >/dev/null
  local file=$(mktemp -d)/smoke-upload.txt
  print "smoke upload" >$file
  check "the-internet: file input took the file" 'to smoke-upload.txt \(13 bytes' file-upload $(ref "" button) $file
  check "the-internet: upload submitted" 'navigated' click $(ref "Upload" button)
  sleep 2
  check "the-internet: server got the file" '^smoke-upload.txt$' text
  rm -r ${file:h}
  close_tab
}

# mcp_request METHOD PARAMS [SECONDS]: sends one JSON-RPC request to the coprocess and leaves its response in $output.
mcp_id=0
mcp_request() {
  mcp_id=$((mcp_id + 1))
  print -p -- "$(jq -nc --argjson id $mcp_id --arg method $1 --argjson params $2 '{jsonrpc: "2.0", id: $id, method: $method, params: $params}')"
  local line

  while read -r -t ${3:-60} -p line; do
    [[ $(jq -r '.id // empty' <<<$line) == $mcp_id ]] || continue
    output=$line
    return
  done

  output="no reply to $1 within ${3:-60} s"
}

# mcp_check LABEL PATTERN TOOL ARGS [SECONDS]: calls a tool; output is its text, [image] per image and isError when it failed.
mcp_check() {
  mcp_request tools/call "$(jq -nc --arg name $3 --argjson arguments $4 '{name: $name, arguments: $arguments}')" $5
  [[ $output == \{* ]] && output=$(jq -r '((.result.content // [])[] | if .type == "text" then .text else "[\(.type)]" end), (if .result.isError then "isError" else empty end), (.error.message // empty)' <<<$output)
  verdict $1 $2
}

site_mcp() {
  local log=$(mktemp)
  coproc safaripilot mcp 2>$log
  local server=$!
  mcp_request initialize '{"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "SafariPilot smoke", "version": "1"}}'
  verdict "mcp: initialize" '"name":"safaripilot"'
  print -p '{"jsonrpc": "2.0", "method": "notifications/initialized"}'
  mcp_request tools/list '{}'
  output=$(jq -r '.result.tools[].name' <<<$output)
  verdict "mcp: tools listed" '^browser_batch$'
  # The first call that touches Safari waits for approval.
  mcp_check "mcp: tab_create" '^opened tab' tab_create '{"url": "https://the-internet.herokuapp.com/javascript_alerts"}' 120
  local opened=$(print -r -- "$output" | awk '/^opened tab/ {print $3; exit}')
  sleep 2
  mcp_check "mcp: find" '\] button "Click for JS Prompt"' find '{"name": "JS Prompt", "role": "button"}'
  local prompt=$(print -r -- "$output" | sed -nE '1s/^\[([0-9:]+)\].*/\1/p')
  mcp_check "mcp: click opens a prompt" 'opened a prompt' click "$(jq -nc --arg ref $prompt '{ref: $ref}')"
  mcp_check "mcp: handle_dialog" 'accepted a prompt' handle_dialog '{"action": "accept", "prompt_text": "mcp"}'
  mcp_check "mcp: browser_batch" '^2/2 screenshot:' browser_batch '{"actions": [{"name": "get_page_text"}, {"name": "screenshot", "input": {"scale": 0.3}}]}'
  verdict "mcp: page text in batch" '^You entered: mcp$'
  verdict "mcp: screenshot image in batch" '^\[image\]$'
  mcp_check "mcp: tab_close" 'closed tab' tab_close "{\"tabId\": ${opened:-0}}"
  kill $server 2>/dev/null
  grep -q failed $log && print "    server stderr:\n$(grep failed $log | head -5 | sed 's/^/    /')"
  rm $log
}

sites=($@)
((${#sites})) || sites=(wikipedia hackernews github mdn httpbin network youtube osm npm apple w3schools bbc discourse frames reddit facebook theinternet mcp)

for site in $sites; do
  site_$site
done

print "\n$failures failed"
((failures == 0))
