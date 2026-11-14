import type { Failure, WaitForResult } from "../shared/protocol";
import { collapse, isEditableRoot } from "./describe";
import { flatChildren, flatElements, isInvisible, isPruned } from "./flat";
import { readViewport, visibleArea } from "./geometry";
import { isSensitive } from "./sensitive";
import { elementInfo, hasBox } from "./snapshot";

let formTags = new Set(["input", "select", "textarea"]);

type Span = { element: Element; start: number; end: number };

// The text a person sees under root, whitespace collapsed, and where each shown element's text sits in it, children before their parents.
// It walks the flat tree find and read_page use; block boxes and br separate words, and form field values (a textarea's default text too) and secret editors are left out.
let isField = (node: Node) =>
  node instanceof Element &&
  (formTags.has(node.localName) || (isEditableRoot(node) && isSensitive(node)));

export function shownText(root: Node) {
  let text = "";
  let spans: Span[] = [];
  let add = (piece: string) => {
    let clean = piece.replace(/\s+/g, " ");

    if (clean.startsWith(" ") && (!text || text.endsWith(" ")))
      clean = clean.slice(1);

    text += clean;
  };
  let walk = (node: Node, invisible: boolean) => {
    for (let child of flatChildren(node)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!invisible) add(child.textContent ?? "");

        continue;
      }

      if (!(child instanceof Element)) continue;

      if (child.localName === "br") {
        add(" ");
        continue;
      }

      if (isPruned(child) || isField(child)) continue;

      let hidden = isInvisible(child);
      let gap = /^(inline|contents|$)/.test(getComputedStyle(child).display)
        ? ""
        : " ";
      add(gap);
      let start = text.length;
      walk(child, hidden);

      if (!hidden) spans.push({ element: child, start, end: text.length });

      add(gap);
    }
  };
  if (!isField(root)) walk(root, root instanceof Element && isInvisible(root));

  return { text, spans };
}

let escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The deepest shown element with a box whose text holds the first occurrence of text.
function byText(text: string) {
  let { text: shown, spans } = shownText(document);
  let needle = text.replace(/\s+/g, " ").trim();
  let found = new RegExp(escape(needle), "i").exec(shown);

  if (!found) return null;

  let end = found.index + needle.length;
  let span = spans.find(
    (each) =>
      each.start <= found.index && end <= each.end && hasBox(each.element),
  );

  if (!span) return null;

  return {
    element: span.element,
    text: shown.slice(span.start, span.end),
  };
}

// The first element in document order matching selector that is shown and has a box.
function bySelector(selector: string) {
  for (let element of flatElements(document)) {
    if (!element.matches(selector) || !hasBox(element)) continue;

    return { element, text: shownText(element).text };
  }

  return null;
}

export function waitFor(
  text: string | null,
  selector: string | null,
): WaitForResult | Failure {
  if ((text === null) === (selector === null))
    return {
      ok: false,
      error: "waitFor takes either text or selector",
      code: "invalid_argument",
    };

  if (selector !== null) {
    try {
      document.querySelector(selector);
    } catch {
      return {
        ok: false,
        error: `${JSON.stringify(selector)} is not a valid CSS selector`,
        code: "invalid_argument",
      };
    }
  }

  let found = text === null ? bySelector(selector!) : byText(text);
  let match = found && {
    ...elementInfo(found.element, visibleArea(readViewport())),
    text: collapse(found.text),
  };
  return { ok: true, url: location.href, title: document.title, match };
}
