import type { ReadPageResult } from "../shared/protocol";
import { collapse, contentRoles, nameOf, roleOf } from "./describe";
import { flatChildren, isPruned } from "./flat";
import { readViewport } from "./geometry";
import { pruneRefs, refFor } from "./refs";
import { isInteractive } from "./snapshot";

type Item =
  | { text: string }
  | { element: Element; role: string; name: string; children: Item[] };

type Output = { lines: string[]; length: number; maxChars: number };

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

export function displayName(element: Element, role: string) {
  return nameOf(element, isInteractive(element) || contentRoles.has(role));
}

function pushText(items: Item[], text: string) {
  let last = items.at(-1);

  if (last && "text" in last) {
    last.text = `${last.text} ${text}`;
    return;
  }

  items.push({ text });
}

function build(node: Node, interactiveOnly: boolean): Item[] {
  let items: Item[] = [];

  for (let child of flatChildren(node)) {
    if (child.nodeType === Node.TEXT_NODE) {
      let text = interactiveOnly ? "" : collapse(child.textContent, textMax);

      if (text) pushText(items, text);

      continue;
    }

    if (!(child instanceof Element) || isPruned(child)) continue;

    let role = roleOf(child);
    let interactive = isInteractive(child);
    let name = displayName(child, role);
    let children = leafTags.has(child.localName)
      ? []
      : build(child, interactiveOnly);
    let shown = interactiveOnly
      ? interactive
      : interactive ||
        (role === "img" ? name !== "" : !collapsibleRoles.has(role) || !!name);

    if (!shown) {
      for (let item of children) {
        if ("text" in item) pushText(items, item.text);
        else items.push(item);
      }

      continue;
    }

    let fromContent = interactive || contentRoles.has(role);

    if (fromContent && name)
      children = children.filter((item) => !("text" in item));

    if (!name && children.length === 1 && "text" in children[0]) {
      name = collapse(children[0].text, textMax);
      children = [];
    }

    items.push({ element: child, role, name, children });
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

    if (!render(children, depth + 1, output)) return false;
  }

  return true;
}

export function treeText(
  root: Node,
  filter: "interactive" | "all",
  maxChars: number,
) {
  let output: Output = { lines: [], length: 0, maxChars };
  let complete = render(build(root, filter === "interactive"), 0, output);
  return { text: output.lines.join("\n"), truncated: !complete };
}

export function readPage(
  filter: "interactive" | "all",
  maxChars: number,
): ReadPageResult {
  pruneRefs();
  return {
    ok: true,
    url: location.href,
    title: document.title,
    viewport: readViewport(),
    ...treeText(document.body ?? document.documentElement, filter, maxChars),
  };
}
