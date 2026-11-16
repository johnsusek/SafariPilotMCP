# Architecture

How SafariPilot works inside. For what it does and how to use it, see the [README](../README.md).

## Parts

| Part | Where | Role |
| --- | --- | --- |
| App | `App/` | Menu bar app, with a Dock icon only while its window is open. The CLI launches it in the background when it is not running. Hosts the loopback listener, approval gate, command queue, Accessibility engine and activity log. |
| Safari Web Extension | `Appex/`, `web/src/` built to `extension/` | MV3 event-page background, isolated-world content script (`content.js`) and main-world capture script (`main.js`) in every frame. |
| CLI and MCP server | `CLI/` | `safaripilot mcp` speaks MCP over stdio (official `modelcontextprotocol/swift-sdk`). Release builds run only `mcp` and `status`. |
| Shared | `Shared/` | Wire types, contract, redaction, error codes, viewport and window matching. |

```
Client ──stdio──▶ safaripilot mcp ──TCP 127.0.0.1:47821──▶ SafariPilot.app ◀──native messaging──▶ extension background ──▶ content scripts
                                                                │
                                                                └── Accessibility (AXPress, AXValue) and pid-targeted key events ──▶ Safari
```

## Transport

- One JSON line each way over loopback TCP on `127.0.0.1:47821`.
- The extension background long-polls the app through `sendNativeMessage` (the app answers within 20 s with a command or null). A `connectNative` port wakes it when a command is queued and no poll is open, and a keepalive on that port each minute stops Safari unloading the event page.
- Every connection starts with a per-launch 32-byte token, compared in constant time. It is written to the app group container (read by the app extension) and `~/Library/Application Support/SafariPilot/token`, mode 0600 (read by the CLI).
- MCP clients also need an approved session key from the gate (below). Sessions end when the client process exits.
- Commands run one at a time in arrival order (`CommandQueue`), except `status` and `handle_dialog`.

## Input

- Plain clicks are `AXPress` on the Accessibility element whose frame best matches the content script's element rect (intersection over union of at least 0.7). They produce trusted `mousedown`, `mouseup` and `click`, with Safari in the background.
- Text is set with `AXValue` after a page-side `focus()`. Keys are `CGEvent`s posted to Safari's pid only, never the global HID tap, so they never reach another app. `cmd` chords are refused because Safari acts on them before the page.
- Double, triple, right and modifier clicks, drags, color inputs and file uploads are synthetic, untrusted page events, and replies say so.
- Nothing moves the real cursor or asks Safari to come forward. If Safari activates during a command, the activity log records it. Among Safari's own windows some tools do move focus; the README's Windows and focus section lists them.
- Every action is verified: click counts trusted clicks in the target frame, key counts trusted keydowns, form_input reads the value back. A miss fails with `input_unconfirmed`.
- After an action, a settle step waits up to 15 s for a page load the action started and reports where the tab landed.

## Page diffs

- click, form_input, key, drag and file_upload end with what they changed, so a follow-up read_page is rarely needed. Code: `web/src/content/changes.ts`, `diff` in `web/src/background/page.ts`, `withOutcome` and `changes` in `App/Commands.swift`.
- Right before the input, a `diffStart` op in the top frame and the acted ref's frame keeps the rendered tree (read_page's walk with filter all) and starts a MutationObserver, open shadow roots included. Other frames are not read.
- After the action's own check, `diff` waits until the DOM has been still for 100 ms (inline style changes do not count, so a scripted animation cannot hold it) and every fetch and XHR started since `diffStart` has finished (counted by the main-world capture), at most 2 s after the input, then walks again. It answers added subtrees as read_page lines with refs, changed elements with what they were, changed text, and the topmost removed elements, each under a line naming its nearest surviving ancestor.
- A navigation, a replaced acted frame or an opened dialog leaves the reply as it was. A page past 20000 elements is too large to diff. Replies cut the diff at 2000 characters and count what was left out.

## Targets

- click, form_input, key, scroll, scroll_to and file_upload take a ref or a name and/or role. Code: `target` in `web/src/content/find.ts` and `web/src/background/page.ts`, `resolving` in `App/Commands.swift`.
- A name costs one round trip before the action. Every frame find reads walks its rendered elements with find's matching, offscreen ones included, and the background takes the only exact name (case and surrounding whitespace ignored), else the only match. A role alone needs exactly one match.
- No match or several fail before anything acts; several list up to 20 candidates with refs, exact names first. Otherwise the reply starts with the element and ref it resolved to, and the ref path runs unchanged.

## Pages

- Refs come from the content script on first sight per frame, stored in a WeakMap, and numbered from a random base per document so a stale ref fails instead of hitting another element.
- Iframes, same- and cross-origin, are read inline and actionable. Refs inside frames are paths such as `5:12`.
- read_page with viewport keeps elements whose box meets the visible part of their frame, narrowed inside each overflow-clipping container, plus their ancestors, and reads only the frames in view, each within the part shown. It still walks offscreen subtrees, since fixed and absolute descendants can sit in view, and reports how many CSS px of content lie above and below. Code: `inView` in `web/src/content/tree.ts`, `readFrame` in `web/src/background/page.ts`.
- get_page_text markdown walks the same flat tree as read_page (shadow roots, slots, hidden pruning) in `web/src/content/markdown.ts`, never innerText, and leaves out every form field value. ref_id reads one element in its own frame, then only the frames inside it.
- Alert, confirm and prompt dialogs stop the whole extension, so the app finds them through Accessibility and answers them with `AXPress`.
- Console capture and fetch/XHR body capture run in the page's main world. Request metadata comes from `webRequest`, logged for pilot tabs only.

## Isolation and redaction

- The MCP server sees only tabs it opened plus their popups (by `openerTabId`). All sessions share one SafariPilot window.
- Secret fields (passwords, OTP, card numbers and secret-named fields, rules in `web/src/content/sensitive.ts`) never leave the content script; they show as `value=[hidden]`.
- URL credentials and secret query or fragment parameters are hidden in every reply (`web/src/shared/redact.ts` and `Shared/Redaction.swift`, sharing `redactUrl.cases.json`). Cookie, Set-Cookie and secret headers and body fields are hidden in network logs.
- page_fetch (`web/src/background/pageFetch.ts`) sends from the page's main world with the `fetch` the capture kept at document_start, over a CustomEvent pair whose request no page listener sees. A replay fills in the logged request's raw headers, which the background keeps beside the redacted ones in memory only and never puts in a reply; Cookie, Origin, Referer, `sec-` and the browser's own headers are left for the browser. Its reply goes through the same redaction before `pick`, so a path cannot lift a hidden value out from under its name.
- page_fetch sends only to the tab's own origin and origins already in its network log.
- The activity log shows typed text by size, never in clear, and page_fetch by method, redacted URL, header names and body sizes.

## Timing

- Every command records how long each phase took: its wait in the queue, each extension round trip (named after its content op or command type, with the native messaging around it summed as `transport`), the dialog check before each round trip, AX window and element resolution, the press or keys, fixed sleeps, the settle step and the diff. Code: `Shared/Timing.swift`, a task local the app's command code records into.
- The background reports how long it ran each command, which splits a round trip into the op and its transport.
- The activity log shows each command's total and phases; the Debug CLI prints them with `--timing` and returns them in `--json`.

```bash
scripts/bench.sh [RUNS] [click form_input key read_page find wait_look wait ...]
```

Medians of each command's time in the app, CLI wall time and each phase over RUNS runs (default 15) against `testpage/`, served by `npm --prefix web run testpage`. Needs the Debug app.

## Errors

Every failure ends with `error code=CODE retryable=BOOL next=STEP`, drawn from 18 codes and 8 next steps fixed in `web/src/shared/errorCodes.json` and checked on both sides by tests.

## Build and test

```bash
scripts/install.sh
```

Builds Release, replaces `/Applications/SafariPilot.app`, unregisters stale copies (Safari otherwise runs whichever copy LaunchServices picks), relaunches and links `safaripilot` into `/opt/homebrew/bin`. `--debug` installs the build with dev commands.

```bash
scripts/test.sh
```

Runs the web and Swift tests headless.

```bash
scripts/smoke.sh
```

Runs live checks against real sites and an MCP stdio session. Sites change, so a failure means look, not necessarily a regression.

```bash
scripts/release.sh X.Y.Z
```

Sets the version, commits, tags `vX.Y.Z` and pushes. The tag starts the Release workflow, which builds a Developer ID signed DMG, notarizes and staples it, signs the Sparkle appcast, publishes a GitHub release with `docs/releases/X.Y.Z.md` as its notes and bumps the Homebrew cask. Running the workflow by hand from a branch is a dry run that attaches the DMG to the run.

Every build gets a unique identity; the app refuses commands when Safari runs an extension from a different build, naming the stale copy's path.
