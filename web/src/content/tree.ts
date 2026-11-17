import type {
  Failure,
  FramePlaceholder,
  ReadPageResult,
  Rect,
} from "../shared/protocol";
import {
  authorRoles,
  collapse,
  contentRoles,
  isEditableRoot,
  nameOf,
  roleOf,
} from "./describe";
import {
  flatChildren,
  isInvisible,
  isPruned,
  isShown,
  setsApart,
} from "./flat";
import {
  blocksScripts,
  contentBox,
  type FrameHost,
  frameIdOf,
  isFrameHost,
  sourceOf,
} from "./frames";
import {
  boxOf,
  intersect,
  readViewport,
  toRect,
  visibleArea,
} from "./geometry";
import { pruneRefs, refFor, resolveRef } from "./refs";
import { hidden, redactUrl } from "../shared/redact";
import { isSensitive } from "./sensitive";
import { isInteractive } from "./snapshot";

export type Item =
  | { text: string }
  | { element: Element; role: string; name: string; children: Item[] };

// A viewport read: clip is the part of this frame the user can see, in its client coordinates, narrowed inside each overflow-clipping container;
// above and below are how far left-out content reaches past its top and bottom edges, CSS px; frames holds each kept iframe's visible part in its own frame's coordinates.
type View = {
  clip: Rect;
  above: number;
  below: number;
  frames: Map<Element, Rect | null>;
};

// left is a lower bound on output characters still wanted; building stops once it runs out, since a large page would otherwise be walked whole for a short answer.
// nodes is how many more elements may be looked at, which bounds the walk's time on a huge page.
export type Walk = {
  interactiveOnly: boolean;
  left: number;
  nodes: number;
  view?: View;
};

type Output = {
  lines: string[];
  length: number;
  maxChars: number;
  maxDepth: number;
  prefix: string;
  frames: FramePlaceholder[];
  view?: View;
};

let leafTags = new Set([
  "input",
  "textarea",
  "select",
  "img",
  "svg",
  "iframe",
  "frame",
  "video",
  "audio",
  "canvas",
  "progress",
  "meter",
  "hr",
]);
let collapsibleRoles = new Set(["generic", "none", "presentation"]);
let textInputTypes = new Set([
  "text",
  "email",
  "search",
  "url",
  "tel",
  "password",
  "number",
  "range",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
  "color",
]);
let textMax = 300;
let range = document.createRange();
let valueMax = 40;
let hrefMax = 60;

// Whether box shows in a viewport read; one that does not counts toward what was left out above or below.
function inView(view: View, box: DOMRect) {
  let { clip } = view;

  if (intersect(toRect(box), clip)) return true;

  if (box.width <= 0 || box.height <= 0) return false;

  let bottom = clip.top + clip.height;
  view.above = Math.max(view.above, clip.top - box.top);
  view.below = Math.max(view.below, box.bottom - bottom);
  return false;
}

let clipping = /^(hidden|clip|auto|scroll)$/;

// body's and the root's overflow can belong to the viewport, so only containers below them clip.
function clips(element: Element) {
  if (element === document.body || element === document.documentElement)
    return false;

  let style = getComputedStyle(element);
  return clipping.test(style.overflowX) || clipping.test(style.overflowY);
}

// Text runs join as the page draws them, with a space only where whitespace, a block box or a line break separates them, so a word split by inline markup
// (a highlighted search match) stays whole. A run keeps one space at an edge that had whitespace; readers trim it.
function pushText(items: Item[], text: string) {
  let last = items.at(-1);

  if (last && "text" in last) {
    last.text = `${last.text}${text}`.replace(/\s+/g, " ");
    return;
  }

  items.push({ text });
}

function gap(items: Item[]) {
  let last = items.at(-1);

  if (last && "text" in last && !last.text.endsWith(" ")) last.text += " ";
}

// Adds what a child that shows no line of its own holds to items, set off by spaces when the child sets its text apart.
function splice(items: Item[], child: Element, children: Item[]) {
  let block = setsApart(child);

  if (block) gap(items);

  for (let item of children) {
    if ("text" in item) pushText(items, item.text);
    else items.push(item);
  }

  if (block) gap(items);
}

// Adds child to items: text joins the previous run, and an element that is not shown gives its children up to the parent.
function add(items: Item[], child: Node, walk: Walk) {
  let interactiveOnly = walk.interactiveOnly;

  if (child.nodeType === Node.TEXT_NODE) {
    let raw = child.textContent ?? "";
    let text = interactiveOnly ? "" : collapse(raw, textMax);

    if (!text) {
      if (/\s/.test(raw)) gap(items);

      return;
    }

    if (walk.view) {
      range.selectNodeContents(child);

      if (!inView(walk.view, range.getBoundingClientRect())) return;
    }

    pushText(
      items,
      `${/^\s/.test(raw) ? " " : ""}${text}${/\s$/.test(raw) ? " " : ""}`,
    );
    walk.left -= text.length + 2;
    return;
  }

  if (!(child instanceof Element)) return;

  if (child.localName === "br") {
    gap(items);
    return;
  }

  walk.nodes -= 1;

  if (isPruned(child)) return;

  if (isInvisible(child)) {
    splice(items, child, build(child, walk));
    return;
  }

  let view = walk.view;
  let box = view ? boxOf(child) : null;
  // Out of view, an element shows only as the ancestor of something in view, without its own text.
  let outside = view ? !inView(view, box!) : false;
  let clip = view?.clip;

  if (view && !outside && clips(child))
    view.clip = intersect(view.clip, toRect(box!))!;

  let children =
    leafTags.has(child.localName) || isEditableRoot(child)
      ? []
      : build(child, walk, outside);

  if (view) view.clip = clip!;

  if (outside && !children.some((item) => "element" in item)) return;

  let role = roleOf(child);
  let interactive = isInteractive(child);
  // An iframe whose frame can be read stays as the line its document hangs under.
  let hostsFrame = isFrameHost(child) && frameIdOf(child) >= 0;

  // Its frame is read within the part of it in view, in the frame's own coordinates.
  if (hostsFrame && view) {
    let content = contentBox(child as FrameHost, box!);
    let visible = intersect(content, view.clip);
    view.frames.set(
      child,
      visible && {
        ...visible,
        left: visible.left - content.left,
        top: visible.top - content.top,
      },
    );
  }

  // Containers show their text as children, so only widgets take a name from content, and not a focusable or clickable generic or group wrapping other elements.
  let elements = children.filter((item) => "element" in item).length;
  let wraps = !contentRoles.has(role) && elements > 0;
  let name = nameOf(child, interactive && !wraps && !authorRoles.has(role));
  // A nameless clickable wrapper around a single element adds nothing to it.
  let wrapsOne = collapsibleRoles.has(role) && !name && elements === 1;
  let shown = wrapsOne
    ? false
    : hostsFrame ||
      (interactiveOnly
        ? interactive
        : interactive ||
          (role === "img"
            ? name !== ""
            : !collapsibleRoles.has(role) ||
              child.hasAttribute("aria-label") ||
              child.hasAttribute("aria-labelledby")));

  // A label's text already names its control, a legend's its fieldset and a caption's its table.
  let control = (child as HTMLLabelElement).control;

  if (control && isShown(control))
    children = children.filter((item) => !("text" in item));

  let named = { legend: "fieldset", caption: "table" }[child.localName];

  if (named && child.parentElement?.localName === named) return;

  if (!shown) {
    splice(items, child, children);
    return;
  }

  let fromContent = interactive || contentRoles.has(role);

  if (fromContent && name)
    children = children.filter((item) => !("text" in item));

  if (!name && children.length === 1 && "text" in children[0]) {
    name = collapse(children[0].text, textMax);
    children = [];
  }

  if (
    !interactive &&
    !name &&
    !children.length &&
    !leafTags.has(child.localName)
  )
    return;

  // A widget around a single widget of the same name (a custom element hosting a real button, an option holding its link) shows as the inner one.
  let only = children.length === 1 ? children[0] : null;

  if (
    interactive &&
    only &&
    "element" in only &&
    only.name === name &&
    isInteractive(only.element)
  ) {
    items.push(only);
    return;
  }

  items.push({ element: child, role, name, children });
  walk.left -= role.length + name.length + 8;
}

// The page's items; a body that is itself the editor (TinyMCE's and CKEditor's frames, designMode) is one textbox.
export function rootItems(walk: Walk) {
  let root = document.body ?? document.documentElement;

  if (!isEditableRoot(root)) return build(root, walk);

  let items: Item[] = [];
  add(items, root, walk);
  return items;
}

// outside says node is out of a viewport read's view, so its own text is left out.
export function build(node: Node, walk: Walk, outside = false): Item[] {
  let items: Item[] = [];
  // Text takes its parent's visibility.
  let hidden: boolean | undefined;

  for (let child of flatChildren(node)) {
    if (walk.left <= 0 || walk.nodes <= 0) break;

    if (child.nodeType === Node.TEXT_NODE) {
      hidden ??= outside || (node instanceof Element && isInvisible(node));

      if (hidden) continue;
    }

    add(items, child, walk);
  }

  return items;
}

export function valueOf(element: Element) {
  let tag = element.localName;

  if (tag === "select")
    return Array.from(
      (element as HTMLSelectElement).selectedOptions,
      (option) => option.text,
    ).join(", ");

  if (tag === "textarea") return (element as HTMLTextAreaElement).value;

  if (isEditableRoot(element)) return (element as HTMLElement).innerText;

  if (tag !== "input") return "";

  let input = element as HTMLInputElement;

  if (input.type === "file")
    return Array.from(input.files ?? [], (file) => file.name).join(", ");

  return textInputTypes.has(input.type) ? input.value : "";
}

// Credentials are hidden before the href is shortened, so a cut never leaves part of a secret.
function shortHref(anchor: HTMLAnchorElement) {
  let url = new URL(anchor.href, location.href);

  if (!url.protocol.startsWith("http"))
    return collapse(redactUrl(url.href), hrefMax);

  let path = `${url.pathname}${url.search}${url.hash}`;
  return collapse(
    redactUrl(url.origin === location.origin ? path : `${url.host}${path}`),
    hrefMax,
  );
}

export function statesOf(element: Element, role: string) {
  let states: string[] = [];
  let html = element as HTMLInputElement;
  let aria = (name: string) => element.getAttribute(`aria-${name}`);

  if (role === "heading") {
    let level = aria("level") ?? element.localName.match(/^h([1-6])$/)?.[1];

    if (level) states.push(`level=${level}`);
  }

  if (html.checked === true || aria("checked") === "true")
    states.push("checked");

  if (aria("checked") === "mixed") states.push("mixed");

  if (html.disabled === true || aria("disabled") === "true")
    states.push("disabled");

  let details = element.parentElement;
  let expanded =
    aria("expanded") ??
    (element.localName === "summary" && details instanceof HTMLDetailsElement
      ? String(details.open)
      : null);

  if (expanded === "true") states.push("expanded");

  if (expanded === "false") states.push("collapsed");

  if (
    aria("selected") === "true" ||
    (element instanceof HTMLOptionElement && element.selected)
  )
    states.push("selected");

  if (aria("pressed") === "true") states.push("pressed");

  if (aria("current") && aria("current") !== "false") states.push("current");

  if (html.required === true || aria("required") === "true")
    states.push("required");

  // file_upload targets these, so they say what they are and what they take.
  if (element instanceof HTMLInputElement && element.type === "file") {
    states.push("type=file");

    if (element.multiple) states.push("multiple");

    if (element.accept) states.push(`accept=${JSON.stringify(element.accept)}`);
  }

  // Line breaks stay, shown as \n, so a change that only adds or removes a line reads as one.
  let lines = valueOf(element)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/^\n+/, "");
  let value =
    lines.length > valueMax ? `${lines.slice(0, valueMax - 3)}...` : lines;

  // Unquoted, so it cannot be read as a field holding the text [hidden].
  if (value)
    states.push(
      `value=${isSensitive(element) ? hidden : JSON.stringify(value)}`,
    );

  if (element instanceof HTMLAnchorElement && element.hasAttribute("href"))
    states.push(`href=${shortHref(element)}`);

  if (isFrameHost(element)) {
    let source = sourceOf(element);
    let host = URL.canParse(source) ? new URL(source).host : "";
    if (host) states.push(`host=${host}`);

    if (source === "srcdoc") states.push(source);

    if (blocksScripts(element)) states.push("sandboxed");

    if (frameIdOf(element) < 0) states.push("(frame not loaded)");
  }

  return states;
}

function emit(output: Output, line: string) {
  let next = output.length + (output.lines.length ? 1 : 0) + line.length;

  if (next > output.maxChars) return false;

  output.lines.push(line);
  output.length = next;
  return true;
}

export let headOf = (role: string, name: string) =>
  name ? `${role} ${JSON.stringify(name)}` : role;

export let quoted = (text: string) => JSON.stringify(collapse(text, textMax));

function render(items: Item[], depth: number, output: Output): boolean {
  let indent = "  ".repeat(depth);

  for (let item of items) {
    if ("text" in item) {
      if (!emit(output, `${indent}${quoted(item.text)}`)) return false;

      continue;
    }

    let { element, role, name, children } = item;
    let states = statesOf(element, role).map((state) => ` ${state}`);
    let ref = refFor(element);
    let line = `${indent}${headOf(role, name)} [ref=${output.prefix}${ref}]${states.join("")}`;

    if (!emit(output, line)) return false;

    let frameId = isFrameHost(element) ? frameIdOf(element) : -1;

    if (frameId >= 0)
      output.frames.push({
        ref,
        frameId,
        line: output.lines.length - 1,
        depth,
        width: element.clientWidth,
        height: element.clientHeight,
        clip: output.view?.frames.get(element) ?? null,
      });

    if (depth + 1 >= output.maxDepth) continue;

    if (!render(children, depth + 1, output)) return false;
  }

  return true;
}

// The walk's budget counts lines that later fold away (a lone text that becomes its element's name, a label's text), so it allows three times the output; a depth limit hides lines it cannot foresee, so then the walk is whole.
let newWalk = (
  filter: "interactive" | "all",
  maxChars: number,
  maxDepth: number,
): Walk => ({
  interactiveOnly: filter === "interactive",
  left: Number.isFinite(maxDepth) ? Infinity : maxChars * 3,
  nodes: Infinity,
});

let newOutput = (
  maxChars: number,
  maxDepth: number,
  prefix: string,
): Output => ({ lines: [], length: 0, maxChars, maxDepth, prefix, frames: [] });

// Every line of items and what is inside them, as read_page shows them from depth 0.
export function linesOf(items: Item[], prefix: string) {
  let output = newOutput(Infinity, Infinity, prefix);
  render(items, 0, output);
  return output.lines;
}

function textOf(
  items: Item[],
  walk: Walk,
  maxChars: number,
  maxDepth: number,
  prefix: string,
) {
  let output = { ...newOutput(maxChars, maxDepth, prefix), view: walk.view };
  let complete = render(items, 0, output);
  return {
    text: output.lines.join("\n"),
    truncated: !complete || walk.left <= 0,
    frames: output.frames,
  };
}

export function treeText(
  root: Node,
  filter: "interactive" | "all",
  maxChars: number,
  maxDepth = Infinity,
  prefix = "",
) {
  let walk = newWalk(filter, maxChars, maxDepth);
  return textOf(build(root, walk), walk, maxChars, maxDepth, prefix);
}

// ref limits the tree to that element and what is inside it; depth limits how many levels are shown.
// viewport keeps what shows in clip, or in this frame's visible area when clip is null.
export function readPage(
  filter: "interactive" | "all",
  maxChars: number,
  ref: number | null,
  depth: number | null,
  prefix: string,
  viewport: boolean,
  clip: Rect | null,
): ReadPageResult | Failure {
  pruneRefs();
  let walk = newWalk(filter, maxChars, depth ?? Infinity);
  let items: Item[] = [];

  if (viewport)
    walk.view = {
      clip: clip ?? visibleArea(readViewport()),
      above: 0,
      below: 0,
      frames: new Map(),
    };

  if (ref === null) items = rootItems(walk);

  if (ref !== null) {
    let element = resolveRef(ref);

    if (!(element instanceof Element)) return element;

    add(items, element, walk);
  }

  return {
    ok: true,
    url: location.href,
    title: document.title,
    viewport: readViewport(),
    ...textOf(items, walk, maxChars, depth ?? Infinity, prefix),
    above: walk.view ? Math.round(walk.view.above) : null,
    below: walk.view ? Math.round(walk.view.below) : null,
  };
}
