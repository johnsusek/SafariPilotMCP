# Iframe support: design

The owner chose the recommended answer (a) for every question in section 2 on 2026-11-12.

The main risk is unconfirmed. If Safari 27 runs cross-site iframes in a separate process (WebKit's Site Isolation), their AX subtree may not be reachable from the top AXWebArea. In that case frame matching would fail on cross-origin frames, so click, form_input and key would fail on them, loudly. I recommend a short spike to settle this and the other Safari unknowns (Q9) before building anything.

## 1. What in the current code constrains the design

1. **Every content call goes to "the tab", with no frame.** `web/src/background/commands.ts:13-15` calls `browser.tabs.sendMessage(tab.id, request)` with no options. With `all_frames: true`, every frame would answer and the first reply wins. So every existing call must pass `{frameId: 0}` before the manifest is flipped.
2. **The manifest is top-frame only.** `extension/manifest.json` has `all_frames: false`, with no `match_about_blank` or `match_origin_as_fallback` and no webNavigation permission. `web/build.mjs` emits one IIFE with an inline sourcemap: `content.js` is 127 KB and would load into every ad frame.
3. **Refs are per-document integers.** `web/src/content/refs.ts:3` (`nextRef = 1`) means every frame would number from 1. Swift uses `Int` refs everywhere:
   - `Shared/Contract.swift`: `ElementInfo.ref`, `LoggedEvent.ref`, `LocateResult.ref` and every `ContentRequest` case.
   - `Shared/CLIWire.swift`: every `AppCommand` case that carries a ref.
   - `CLI/Tools.swift:21` gives ref the schema type integer, and `ToolArguments.integer` at `:137` turns quoted digits into Int.
   - `CLI/CommandLineParsing.swift:56` and others parse refs with `integer(...)`.

   A dotted form like `5.12` would be read as a number, and `5.10` would silently become `5.1`.
4. **The coordinate contract is already "top-level layout viewport".** `web/src/shared/protocol.ts:2` says so. `ViewportMapping` (`Shared/ViewportMapping.swift:31-43`) and `AXEngine.resolve` (`App/AX/AXEngine.swift:80-112`) take one `LocateResult` plus the top viewport. If frame rects arrive already converted to top-viewport CSS px, the app's mapping code does not change.
5. **The AX side mostly works for nested web areas already, if WebKit exposes them.**
   - `findWebAreas` (`AXEngine.swift:63-77`) stops at the first AXWebArea, so nested frame web areas never confuse window matching.
   - `bestMatch` (`:115-141`) walks every child under the top web area, nested web areas included. Frame pruning (`:129`) still holds because a nested web area's frame lies inside its iframe's frame. The 5000/20000 element limits cover frame subtrees too.
   - Site Isolation reports suggest a cross-process iframe can appear as an empty placeholder, with its root having no parent link (WebKit bugs 327631, 285952, 286043). That would break both frame matching and the key focus check below.
6. **locate, hitsTarget and covered are single-document.** `web/src/content/locate.ts:38-109` scrolls with `scrollIntoView`, clips to the frame's own `visibleArea`, and hit-tests with `document.elementFromPoint` (`hit.ts:4`). Inside a frame that only proves the element is on top within that frame. Each ancestor must also confirm that the mapped point lands on its iframe element.
7. **The trusted-click and keydown checks read one document's log.**
   - The logger is a set of window capture listeners per document (`events.ts:125-132`), and `takeEvents` returns that document's `performance.timeOrigin`.
   - click compares origins and looks for a trusted click (`App/Commands.swift:253-267`).
   - key counts trusted keydowns from the tab's single log (`App/CG/Key.swift:28-71`; the line at `:66` already blames iframes for a shortfall).
   - Keys typed into a frame are logged only in that frame's document, and a frame navigating changes only that frame's origin.
8. **Key's focus check assumes an unbroken AX parent chain.** `requireKeyboardFocus` (`Key.swift:79-105`) needs `focused.chain(upTo: target.webArea)` (`AXNode.swift:54`). That holds for a nested frame only if WebKit links the frame's AX root to its parent.
9. **read_page shows an iframe only as a leaf.** `iframe` is in `leafTags` (`tree.ts:28-41`). With filter interactive it is not shown at all (`tree.ts:99-100`), because iframes are not interactive (`snapshot.ts:29`).
10. **find and get_page_text see one document.**
    - find walks `flatElements(document)` and stops at 20 matches (`find.ts:7,19`).
    - pageText uses `textRoot().innerText` (`pageText.ts:29-36`), which contains no frame text.
    - scroll and scroll_to resolve against `document` (`scroll.ts:14,50`).
11. **The background is non-persistent and is unloaded routinely**. Any ref-to-frame map kept in the background would be lost, so frame routing must be derivable from the ref itself.
12. **No hard rule is in tension.** Everything below stays AX plus pid-targeted keys and never activates Safari.

### Safari WebExtension support (MDN browser-compat-data, read today)

| Feature | Safari support |
|---|---|
| `content_scripts.all_frames` | 14 |
| `match_about_blank`, `match_origin_as_fallback` | 18.4 |
| `world` | 18 |
| `tabs.sendMessage` `options.frameId` | 14 |
| `tabs.sendMessage` `options.documentId` | 18.4 |
| `runtime.getFrameId` | 16 |
| `MessageSender.frameId` | 14 |
| `webNavigation.getAllFrames` / `getFrame` | 14 (needs the `webNavigation` permission) |
| `scripting.executeScript` InjectionResult.frameId | 17 |

Known Safari bugs:
- `tabs.executeScript` ignored `frameId` in Safari 18; `scripting.executeScript` respects it.
- Safari content scripts run only on sites the user has granted. A frame from a not-yet-granted origin gets no script.

None of this has been verified live on Safari 27.

## 2. Questions for the owner (recommended option first)

**Q1. Scope**
- a) **Same-origin and cross-origin**, using `all_frames: true` plus `match_about_blank` and `match_origin_as_fallback`. Each frame runs its own content script and is reached with `tabs.sendMessage({frameId})`.
- b) Same-origin only, walked from the parent through `iframe.contentDocument`. Refs stay integers and the manifest does not change, but MDN live samples and Sourcepoint/TrustArc banners stay out of reach.
- c) Option a, plus a `contentDocument` fallback for same-origin frames whose script never answers.
- d) Other.

**Q2. How frames appear in read_page**
- a) **Inline under the iframe node**, one level deeper. The iframe line shows its title or src host, for example `iframe "Live sample" host=mdn.mozillademos.org [ref=5]`. With filter interactive, iframe lines that host a reachable frame are kept.
- b) Separate sections after the top tree, headed `--- frame 5 (host) ---`.
- c) The iframe is a placeholder only, and `read_page ref_id=5` expands it.
- d) Other.

**Q3. How refs are namespaced per frame**
- a) **Path strings `"5:12"`**: the iframe's ref in its parent, a colon, then the ref inside the frame. Nested frames read `5:3:12`, and top-frame refs stay `12`. This keeps the background stateless, reuses the existing WeakMap refs, and cannot be mistaken for a number.
- b) Global integers handed out by the background. This needs a map that is lost on background unload, so refs would renumber.
- c) `f<frameId>:12` using Safari's frameId. Those ids are opaque, their size and stability in Safari are unknown, and they mean nothing to the model.
- d) Integer encoding such as `frame*100000+ref`.
- e) Other.

**Q4. Nesting depth and limits**
- a) **At most 3 levels of frames below the top and 20 frames per call**, with a 2 s timeout per frame. Do not descend into frames that are pruned, under 16×16 CSS px, or outside the viewport by more than one screen. These are still shown as lines.
- b) One level only.
- c) No caps, only the command deadline.
- d) Other.

**Q5. get_page_text**
- a) **Main text first, then one labeled section per visible frame of at least 50×50 CSS px**, such as `[frame 5 host]`, in document order, sharing max_chars.
- b) Only frames inside the chosen text root (main or article).
- c) Top document only, plus a `frame` argument.
- d) Inline at each iframe's position. This needs a custom text walk instead of innerText.
- e) Other.

**Q6. find**
- a) **Search every reachable frame**: top first, then frames in document order, 20 matches in total.
- b) Top document only unless the call names a frame.
- c) Other.

**Q7. Counting keydowns for key without a ref**
- a) **Clear and sum trusted keydowns across all reachable frames.** This stays correct when Tab moves focus between frames.
- b) Follow the `document.activeElement` chain only.
- c) Other.

**Q8. Rotated or skewed frames**
- a) **Refuse loudly; support uniform scale only.** AX frames are axis-aligned, so frame matching would fail on them anyway.
- b) Compose full DOMMatrix transforms.
- c) Other.

**Q9. Order of work**
- a) **Phase 0 spike first**: a throwaway branch to measure the 8 unknowns in section 3.0.
- b) Build directly.
- c) Other.

## 3. Plan for the recommended answers

### 3.0 Spike (measure; do not build features yet)

Flip `all_frames`, add a temporary content `ping` that returns `runtime.getFrameId(iframe)` for each iframe, and add nested web areas to debug-ax. Then run against an MDN live sample, the W3Schools Tryit page and the test page, and record each result:

1. Does the script inject into a cross-origin frame (mdn.mozillademos.org)?
2. Does it inject into srcdoc and about:blank frames, including one rewritten with `document.write` (Tryit)?
3. Does it inject into a sandboxed frame without allow-scripts?
4. Does `runtime.getFrameId(element)` return a real id from the isolated world for a cross-origin iframe?
5. Does `tabs.sendMessage(tab, msg, {frameId})` reach only that frame?
6. Is the cross-origin frame's AX subtree under the top web area, with correct AXPosition and AXSize?
7. Does AXPress inside the frame log a trusted click in the frame?
8. Do pid-targeted keys into a focused field inside the frame log keydowns there, and does `AXFocusedUIElement` chain up to the top web area?

If item 6 fails, cross-origin frames become read-only (read_page, find and text work; acting on them fails loudly) until WebKit fixes it.

### 3.1 Manifest and build

- `extension/manifest.json`: set `all_frames: true`, `match_about_blank: true` and `match_origin_as_fallback: true`. `<all_urls>` already has the wildcard path this needs.
- No webNavigation permission. Frames are found through the parent's iframe elements and `runtime.getFrameId`.
- `web/build.mjs`: consider building `content.js` without the inline sourcemap, since it now loads into every frame.

### 3.2 Protocol (`web/src/shared/protocol.ts`, `commands.ts`; Swift mirror in `Shared/Contract.swift`)

- Split the request types:
  - `PageRequest` is what the app sends. Its refs are `RefPath = string`, accepting `"12"` or `"5:3:12"`.
  - `ContentRequest` is what one frame receives. Its refs stay local numbers.
- Every frame reply carries `origin: performance.timeOrigin`.
- New frame-local ops:
  - `frameBox {ref, reveal}` returns `{frameId, box, scale:{x,y}, skewed, clip, sandbox, src, viewport, origin}` for an iframe ref.
  - `hitFrame {ref, points}` returns `boolean[]`: whether `deepElementFromPoint` at each point is that iframe.
  - `frames {}` lists the iframes in this document with their ref, frameId and box, for fan-out.
- Extended ops:
  - `locate {ref, clip?}` also returns `candidates: Point[]`, up to 8 points that hit the element.
  - `readPage {…, prefix, baseDepth, descendFrames}` returns `frames: [{ref, line, depth}]` placeholders.
  - `find` and `pageText` take `prefix`.
  - `events` takes `scope: RefPath | "all"`.
- `ElementInfo.ref`, `LoggedEvent.ref` and `LocateResult.ref` become RefPath strings.
- Swift: a new `struct PageRef: Codable, Hashable, CustomStringConvertible { frames: [Int]; local: Int }`, with `init(parsing:)` that accepts `^\d+(:\d+){0,3}$`. It decodes from a number or a string and always encodes as a string. Replace `ref: Int` with it in `AppCommand`, `ContentRequest`, `ElementInfo`, `LoggedEvent` and `LocateResult`.
- `EventsResult` gains `origins: [String: Double]`, keyed by frame path, with `""` for the top frame.

### 3.3 Content script (`web/src/content/`)

- **`frames.ts` (new)**
  - `frameIdOf(iframe)` wraps `browser.runtime.getFrameId`; -1 means no frame.
  - `frameBox(ref, reveal)` computes the iframe's content box:
    - `r = getBoundingClientRect()`
    - `sx = r.width / offsetWidth` and `sy = r.height / offsetHeight`
    - `left = r.left + (clientLeft + paddingLeft) * sx`, and likewise for top
    - `width = (clientWidth − paddingX) * sx`
  - It sets `skewed` when sx and sy differ by more than 1%, or when any flat-tree ancestor's `DOMMatrix(getComputedStyle(n).transform)` has a nonzero b or c.
  - `reveal` runs `scrollIntoView({block: "nearest", inline: "nearest"})` only when the box is not fully inside `visibleArea`.
  - It returns `clip = intersect(box, visibleArea)` and reports the `sandbox` attribute.
- **`locate.ts`**
  - The optional `clip` argument is intersected with the frame's own `visibleArea`.
  - It returns `candidates` from `candidatePoints` that pass the owner hit test.
  - The checkbox and label union is unchanged.
- **`tree.ts`**
  - Add an item kind for an iframe whose `frameIdOf` is at least 0. It is kept even under filter interactive and renders as `iframe "name" host=… [ref=P5]`, where P is the prefix.
  - `render` records `{ref, line index, depth}` for each such iframe.
  - `refFor` output gets the prefix. Add a `baseDepth` offset for the indent and the depth limit.
  - Unreachable frames render with a suffix: `(frame not loaded)`, `(sandboxed, no scripts)` or `(no content script)`.
- **`find.ts`, `pageText.ts`, `events.ts`**: only the prefix and scope plumbing. `toLogged` keeps the local ref; the background adds the path.
- **`index.ts`**: route the new ops.

### 3.4 Background (`web/src/background/`)

- **`commands.ts`**: `sendToContent` takes a `frameId`, sends `{frameId: 0}` by default, and adds a per-frame 2 s `Promise.race`. A content command parses the RefPath and calls into `frames.ts`.
- **`frames.ts` (new; pure geometry in `shared/frameGeometry.ts`)**
  - `walkPath(tabId, path, reveal)` hops top-down: `frameBox(ref_i)` in frame_i gives frameId_{i+1}. It stops at more than 3 hops, at frameId −1, or when a frame does not answer: "iframe 5 has no content script (not loaded, sandboxed without allow-scripts, or origin not allowed); scroll_to 5 and retry". A changed origin between hops yields "frame navigated during the call; read_page again".
  - Geometry, top-down: `clipChild = (clipParent ∩ box − box.origin) / s`.
  - Geometry, bottom-up: `rectTop = box.origin + rectChild * s`, composed level by level. The top viewport (with pinch) comes from frame 0's reply, so the app's `ViewportMapping` stays unchanged. A child's own `scrollX/Y` needs no handling because child rects are relative to the child's viewport. Skewed at any level means `hitsTarget: false` with "inside a rotated or skewed frame".
- **`locatePath`**
  1. `walkPath` with reveal.
  2. Child `locate(ref, clip)`. This centers the element in the child, and Safari may also scroll ancestors.
  3. `walkPath` again without reveal to re-measure the boxes.
  4. Map the candidates up and run `hitFrame` per ancestor. The first candidate that passes every level wins. Otherwise return `covered: true` with "frame 5 covered by X". If the child itself is not hit, return the child's result mapped up.
  5. Return a top-coordinate `LocateResult` with ref equal to the path.
- **read_page**: frame 0 runs `readPage` with `descendFrames`. The placeholders are filled in document order, each by recursing with `prefix = path + ":"`, `baseDepth = depth + 1` and the remaining budget, then spliced after the placeholder line. The final cut to max_chars falls on a line boundary and sets `truncated`. `ref_id` routes to the owning frame; `ref_id` of an iframe means "that frame's whole document". Caps: 20 frames, and no descent into frames under 16×16 CSS px or more than one viewport offscreen.
- **find / pageText / events scope "all"**: fan out over `frames` recursively under the same caps, prefix the refs, and map find rects to top coordinates before computing `inViewport`.
- **scroll / scroll_to**: route to the frame that owns the ref. `scroll_to` also reveals each ancestor's iframe. `scroll ref=<iframe ref>` scrolls that frame's document.

### 3.5 App (Swift)

- **`App/Commands.swift`**
  - Refs become `PageRef` throughout.
  - `click` takes the `events` origins for the ref's frame and for the top frame before the press. Afterwards it counts trusted clicks from the ref's frame. The page counts as navigated if either origin changed, or if the frame no longer answers and the top origin changed (for example a `target=_top` link).
  - debug-ax lists nested web areas under the target web area with their frames, so the spike and later calibration can see them.
- **`App/CG/Key.swift`**
  - Before the presses, run `events(scope: "all", clear)`; afterwards, the same.
  - Sum trusted keydowns over the frames present in both reads. "Navigated" applies only if the top origin changed or the origin of the ref's frame changed, so an ad frame reloading does not count.
  - In `requireKeyboardFocus`, also accept a focused element whose ancestor is an AXWebArea in the same AXWindow whose frame lies inside the top web area's frame. This covers frames whose AX parent link may be missing.
  - Reword the message at `:66`.
- **`App/FormInput.swift`**: no logic change. inspect, locate and the read-back already go through the ref and are routed by the background.
- **`AXEngine.swift`**: no change expected, pending spike item 6.

### 3.6 CLI and MCP

- `CLI/Tools.swift`: the ref schema type becomes `["integer", "string"]`, described as "Element ref from read_page or find, such as 12, or 5:12 for an element inside the frame of iframe 5".
- Add `ToolArguments.ref(_:)`. Integers map to top-frame refs, path strings are parsed, and a non-integer number such as 5.12 is refused with "refs inside frames are strings like \"5:12\"". Use it for `ref`, `ref_id` and the key and scroll refs.
- Add one line to `instructions` saying that iframe content shows up under its iframe.
- `CLI/CommandLineParsing.swift`: parse every ref argument with `PageRef(parsing:)`.

### 3.7 Failure modes

| Situation | Behavior |
|---|---|
| Frame not loaded yet, or lazy and offscreen | getFrameId is −1 or no answer: tree shows `(frame not loaded)`; acting on its refs fails, suggesting scroll_to on the iframe ref |
| Sandboxed without allow-scripts | Behavior depends on spike item 3; if not injected: `(sandboxed, no scripts)` and loud failures |
| about:blank or srcdoc | Covered by `match_about_blank`. A `document.write` rewrite keeps the Window, so the listeners survive but old refs die (spike item 2). If injection fails, Q1-c is the fallback |
| Frame navigated mid-call | Detected by an origin mismatch between hops or between events reads ("frame navigated…"). In click this counts as navigated |
| Origin not granted in Safari | Same as "no content script"; the message mentions site access |
| Cross-process AX gap | Frame matching fails with the existing "no AX element matches" error, plus a hint that the element is inside a cross-origin frame |

### 3.8 Tests

**vitest, `web/`**
- `background/commands.test.ts`: every plain send carries `{frameId: 0}`.
- New `background/frames.test.ts`, with a fake `tabs.sendMessage` keyed by frameId:
  - Path hops for `5:3:12`, with errors at each hop.
  - Nested offsets, including a 0.5-scaled iframe, a border plus padding, and a scrolled parent.
  - Clip propagation.
  - Ancestor `hitFrame` rejecting the first candidate and accepting the second.
  - A skewed frame refused.
  - An origin change mid-path.
  - read_page splicing: indent, prefix, budget cut, `truncated`, and the 20-frame and depth caps.
  - find merge with the 20-match cap and mapped `inViewport`.
  - The key fan-out sum.
- `shared/frameGeometry.test.ts`: pure math.
- Content side:
  - `tree.test.ts`: an iframe line is kept under filter interactive, the prefix appears on refs, `baseDepth` works, and the unreachable-frame suffix shows.
  - `locate` with a clip.
  - `frameBox` with stubbed rects, as `geometry.test.ts` does.

**Swift, `Tests/`**
- `ToolMappingTests`: ref 12, `"12"`, `"5:12"` and `"5:3:12"` are accepted; 5.12, `"5.12"` and five levels are refused.
- `ContractTests` and `WireTests`: `PageRef` decodes from a number or a string and encodes as a string, and `ContentRequest` JSON carries path refs.
- `FrameMatchingTests`: a nested-web-area tree where the best match lies under an inner AXWebArea.
- A test for the new focus-acceptance rule, factored into a pure function.

**Test page (`testpage/`)**
- A srcdoc iframe with a button and an input.
- A nested iframe.
- A cross-origin iframe, served from `localhost:8765` while the page is on `127.0.0.1:8765`.
- An iframe scaled 0.5 by a transform.
- A sandboxed iframe without allow-scripts.
- A `loading=lazy` iframe below the fold.

### 3.9 Smoke check (`scripts/smoke.sh`)

- Widen the `ref()` regex to `^\[([0-9:]+)\]`.
- Add `site_frames` and include it in the default list. Verify the sample texts live before committing.

```
site_frames() {
  open_tab "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button"
  check "frames: live sample inlined" '\[ref=[0-9]+:[0-9]+\]' read-page --max-chars 20000
  check "frames: cross-origin button clicked" 'click on' click $(ref "Add to favorites" button)
  check "frames: frame text in page text" 'Add to favorites' text
  close_tab
  open_tab "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/text"
  local field=$(ref "Name" textbox)   # first match may be top-page; pick the one containing ':'
  check "frames: form-input in frame" '\(matches\)' form-input $field "abcd"
  check "frames: keys counted in frame" 'keydowns reached' key --ref $field --text "ef"
  close_tab
  open_tab "https://www.w3schools.com/tags/tryit.asp?filename=tryhtml_button_test"
  check "frames: tryit result button" 'click on' click $(ref "Click Me" button)
  close_tab
}
```

### Critical files for implementation
- /Users/john/Code/SafariPilot/web/src/background/commands.ts (plus new /Users/john/Code/SafariPilot/web/src/background/frames.ts)
- /Users/john/Code/SafariPilot/web/src/shared/protocol.ts and /Users/john/Code/SafariPilot/Shared/Contract.swift
- /Users/john/Code/SafariPilot/web/src/content/locate.ts and /Users/john/Code/SafariPilot/web/src/content/tree.ts
- /Users/john/Code/SafariPilot/App/Commands.swift and /Users/john/Code/SafariPilot/App/CG/Key.swift
- /Users/john/Code/SafariPilot/CLI/Tools.swift and /Users/john/Code/SafariPilot/extension/manifest.json

### Sources
- [MDN browser-compat-data: content_scripts](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/content_scripts.json)
- [MDN browser-compat-data: tabs](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/tabs.json)
- [MDN browser-compat-data: runtime](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/runtime.json)
- [MDN browser-compat-data: webNavigation](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/webNavigation.json)
- [MDN browser-compat-data: scripting](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/scripting.json)
- [Apple forums: tabs.executeScript ignores frameId](https://developer.apple.com/forums/thread/765629)
- [Apple forums: content scripts in iframes](https://developer.apple.com/forums/thread/653307)
- [WebKit Site Isolation docs](https://docs.webkit.org/Deep%20Dive/SiteIsolation.html)
- WebKit bugs [327631](https://bugs.webkit.org/show_bug.cgi?id=327631), [285952](https://113070-bug-28966-attachments.webkit.org/show_bug.cgi?id=285952), [286043](https://bugs.webkit.org/show_bug.cgi?id=286043)

## 4. Spike results (2026-11-12)

All 8 unknowns in 3.0 came back favorable, so cross-origin frames are fully actionable. Changes to the plan:

- Refuse any CSS-transformed frame, uniform scale included (Q8): AX reports transformed frames unscaled.
- A sandbox frame without allow-scripts is readable, but its event listeners never fire, so click and key there fail loudly as unverifiable.
- Do not prune by a nested AXWebArea's frame: it can be the frame document's size, not the iframe box.
- Phase 0 is in place: frameId 0 on every send, all_frames in the manifest, the content `frames` op, `debug-frames`, and nested web areas in `debug-ax`.
