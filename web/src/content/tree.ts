import type { Failure, ReadPageResult } from "../shared/protocol";
import {
  collapse,
  contentRoles,
  isEditableRoot,
  nameOf,
  roleOf,
} from "./describe";
import { flatChildren, isPruned } from "./flat";
import { readViewport } from "./geometry";
import { pruneRefs, refFor, resolveRef } from "./refs";
import { isInteractive } from "./snapshot";

type Item =
  | { text: string }
  | { element: Element; role: string; name: string; children: Item[] };

// left is a lower bound on output characters still wanted; building stops once it runs out, since a large page would otherwise be walked whole for a short answer.
type Walk = { interactiveOnly: boolean; left: number };

type Output = {
  lines: string[];
  length: number;
  maxChars: number;
  maxDepth: number;
};

let leafTags = new Set([
  "input",
  "textarea",
  "select",
  "img",
  "svg",
  "iframe",
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
let valueMax = 40;
let hrefMax = 60;

function pushText(items: Item[], text: string) {
  let last = items.at(-1);

  if (last && "text" in last) {
    last.text = `${last.text} ${text}`;
    return;
  }

  items.push({ text });
}

// Adds child to items: text joins the previous run, and an element that is not shown gives its children up to the parent.
function add(items: Item[], child: Node, walk: Walk) {
  let interactiveOnly = walk.interactiveOnly;

  if (child.nodeType === Node.TEXT_NODE) {
    let text = interactiveOnly ? "" : collapse(child.textContent, textMax);

    if (!text) return;

    pushText(items, text);
    walk.left -= text.length + 2;
    return;
  }

  if (!(child instanceof Element) || isPruned(child)) return;

  let role = roleOf(child);
  let interactive = isInteractive(child);
  let children =
    leafTags.has(child.localName) || isEditableRoot(child)
      ? []
      : build(child, walk);
  // Containers show their text as children, so only widgets take a name from content, and not a focusable or clickable generic wrapping other elements.
  let wraps =
    collapsibleRoles.has(role) && children.some((item) => "element" in item);
  let name = nameOf(child, interactive && !wraps);
  let shown = interactiveOnly
    ? interactive
    : interactive ||
      (role === "img"
        ? name !== ""
        : !collapsibleRoles.has(role) ||
          child.hasAttribute("aria-label") ||
          child.hasAttribute("aria-labelledby"));

  // A label's text already names its control, a legend's its fieldset and a caption's its table.
  let control = (child as HTMLLabelElement).control;

  if (control && !isPruned(control))
    children = children.filter((item) => !("text" in item));

  let named = { legend: "fieldset", caption: "table" }[child.localName];

  if (named && child.parentElement?.localName === named) return;

  if (!shown) {
    for (let item of children) {
      if ("text" in item) pushText(items, item.text);
      else items.push(item);
    }

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

  // A clickable wrapper around a single widget of the same role and name (a custom element hosting a real button) shows as that widget.
  let only = children.length === 1 ? children[0] : null;

  if (
    interactive &&
    only &&
    "element" in only &&
    only.role === role &&
    only.name === name
  ) {
    items.push(only);
    return;
  }

  items.push({ element: child, role, name, children });
  walk.left -= role.length + name.length + 8;
}

function build(node: Node, walk: Walk): Item[] {
  let items: Item[] = [];

  for (let child of flatChildren(node)) {
    if (walk.left <= 0) break;

    add(items, child, walk);
  }

  return items;
}

function valueOf(element: Element) {
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
  return textInputTypes.has(input.type) ? input.value : "";
}

function shortHref(anchor: HTMLAnchorElement) {
  let url = new URL(anchor.href, location.href);

  if (!url.protocol.startsWith("http")) return collapse(url.href, hrefMax);

  let path = `${url.pathname}${url.search}${url.hash}`;
  return collapse(
    url.origin === location.origin ? path : `${url.host}${path}`,
    hrefMax,
  );
}

function statesOf(element: Element, role: string) {
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

  let value = collapse(valueOf(element), valueMax);

  if (value) states.push(`value=${JSON.stringify(value)}`);

  if (element instanceof HTMLAnchorElement && element.hasAttribute("href"))
    states.push(`href=${shortHref(element)}`);

  return states;
}

function emit(output: Output, line: string) {
  let next = output.length + (output.lines.length ? 1 : 0) + line.length;

  if (next > output.maxChars) return false;

  output.lines.push(line);
  output.length = next;
  return true;
}

function render(items: Item[], depth: number, output: Output): boolean {
  let indent = "  ".repeat(depth);

  for (let item of items) {
    if ("text" in item) {
      let quoted = JSON.stringify(collapse(item.text, textMax));

      if (!emit(output, `${indent}${quoted}`)) return false;

      continue;
    }

    let { element, role, name, children } = item;
    let label = name ? ` ${JSON.stringify(name)}` : "";
    let states = statesOf(element, role).map((state) => ` ${state}`);
    let line = `${indent}${role}${label} [ref=${refFor(element)}]${states.join("")}`;

    if (!emit(output, line)) return false;

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
});

function textOf(items: Item[], walk: Walk, maxChars: number, maxDepth: number) {
  let output: Output = { lines: [], length: 0, maxChars, maxDepth };
  let complete = render(items, 0, output);
  return {
    text: output.lines.join("\n"),
    truncated: !complete || walk.left <= 0,
  };
}

export function treeText(
  root: Node,
  filter: "interactive" | "all",
  maxChars: number,
  maxDepth = Infinity,
) {
  let walk = newWalk(filter, maxChars, maxDepth);
  return textOf(build(root, walk), walk, maxChars, maxDepth);
}

// ref limits the tree to that element and what is inside it; depth limits how many levels are shown.
export function readPage(
  filter: "interactive" | "all",
  maxChars: number,
  ref: number | null,
  depth: number | null,
): ReadPageResult | Failure {
  pruneRefs();
  let walk = newWalk(filter, maxChars, depth ?? Infinity);
  let items: Item[] = [];

  if (ref === null)
    items = build(document.body ?? document.documentElement, walk);

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
    ...textOf(items, walk, maxChars, depth ?? Infinity),
  };
}
