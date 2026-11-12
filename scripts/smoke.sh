#!/bin/zsh
# Live smoke test against real sites through the installed CLI; prints PASS or FAIL per check and exits nonzero on any failure.
# Sites change, so a failure means look, not necessarily a regression. Run: scripts/smoke.sh [site ...]
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

# check LABEL PATTERN COMMAND...: runs the CLI command on the current tab and greps its output for PATTERN.
check() {
  local label=$1 pattern=$2
  shift 2
  output=$(safaripilot --timeout 30 --tab $tab "$@" 2>&1)

  if print -r -- "$output" | grep -qE -- "$pattern"; then
    print "PASS $label"
    return
  fi

  print "FAIL $label\n$(print -r -- "$output" | head -8 | sed 's/^/    /')"
  failures=$((failures + 1))
}

# ref NAME [ROLE]: the first ref find returns.
ref() { safaripilot --tab $tab find "$1" ${2:+--role} ${2:+$2} | head -1 | sed -nE 's/^\[([0-9]+)\].*/\1/p' }

site_wikipedia() {
  open_tab "https://en.wikipedia.org/wiki/Usage_share_of_web_browsers"
  check "wikipedia: logo link named from its images" 'link "Wikipedia The Free Encyclopedia"' read-page --max-chars 800
  check "wikipedia: table named by caption" 'table "Usage share of mobile browsers"' find --role table
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
  close_tab
}

site_mdn() {
  open_tab "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details"
  check "mdn: svg title names the logo link" 'link "MDN"' read-page --max-chars 600
  local summary=$(ref "Baseline" button)
  check "mdn: summary toggles with click" 'toggled summary' click $summary
  close_tab
  open_tab "https://developer.mozilla.org/en-US/play"
  check "mdn: only editor roots are textboxes" '^\[1\] textbox' find --role textbox
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
}

site_bbc() {
  open_tab "https://www.bbc.com/news"
  check "bbc: block children spaced in link names" 'link "[^"]*[a-z] [A-Z]' find "" --role link
  close_tab
}

sites=($@)
((${#sites})) || sites=(wikipedia hackernews github mdn httpbin youtube osm npm apple w3schools bbc)

for site in $sites; do
  site_$site
done

print "\n$failures failed"
((failures == 0))
