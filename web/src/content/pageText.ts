import { isFrameHost } from "./frames";
import type { Failure, PageTextResult, TextFormat } from "../shared/protocol";
import { flatElements, isBlock, isPruned } from "./flat";
import { markdownOf } from "./markdown";
import { refFor, resolveRef } from "./refs";

let isShown = (element: Element) => element.checkVisibility();

// A visible main wins; a lone article is next; several articles (a feed) read better as the whole body.
export function textRoot() {
  let main = Array.from(document.querySelectorAll("main, [role=main]")).find(
    isShown,
  );

  if (main) return main as HTMLElement;

  let articles = Array.from(document.querySelectorAll("article")).filter(
    isShown,
  );

  if (articles.length === 1) return articles[0] as HTMLElement;

  return document.body ?? document.documentElement;
}

export function clip(text: string, maxChars: number) {
  if (text.length <= maxChars) return { text, truncated: false };

  let cut = text.lastIndexOf("\n", maxChars);
  return { text: text.slice(0, cut > 0 ? cut : maxChars), truncated: true };
}

let isPositioned = (element: Element) =>
  /^(absolute|fixed)$/.test(getComputedStyle(element).position);

// WebKit's innerText puts no break between absolutely positioned blocks, so a virtualized list's rows run together; text around them is joined here with
// a break around each positioned element and block, and every subtree without one keeps its innerText.
function renderedText(root: Element) {
  let positioned = new Set(
    Array.from(root.querySelectorAll("*")).filter(isPositioned),
  );
  let holders = new Set<Element>();

  for (let element of positioned)
    for (
      let at = element.parentElement;
      at && at !== root.parentElement;
      at = at.parentElement
    )
      holders.add(at);

  let textOf = (node: Node): string => {
    // Text nodes are reached only through shown elements; visibility:hidden still hides their own text.
    if (node instanceof Text)
      return getComputedStyle(node.parentElement!).visibility === "hidden"
        ? ""
        : node.data.replace(/\s+/g, " ");
    if (!(node instanceof HTMLElement)) return "";
    if (node.localName === "br") return "\n";
    if (getComputedStyle(node).display === "none") return "";

    let text = holders.has(node)
      ? Array.from(node.childNodes, textOf).join("")
      : node.innerText;
    return positioned.has(node) || isBlock(node) ? `\0${text}\0` : text;
  };

  // Breaks the walk adds are marked, so the ones that meet count once.
  return positioned.size
    ? textOf(root).replace(/\0[\s\0]*/g, "\n")
    : ((root as HTMLElement).innerText ?? "");
}

let innerTextOf = (root: Element) =>
  renderedText(root)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// ref reads that element instead of the main content, and names the iframes in it, itself included, for the background to read after it.
export function pageText(
  maxChars: number,
  format: TextFormat,
  ref: number | null,
): PageTextResult | Failure {
  let root = ref === null ? textRoot() : resolveRef(ref);

  if (!(root instanceof Element)) return root;

  let { text, cut } =
    format === "markdown"
      ? markdownOf(root, maxChars)
      : { text: innerTextOf(root), cut: false };
  let clipped = clip(text, maxChars);
  let frames =
    ref === null || isPruned(root)
      ? []
      : [root, ...flatElements(root)].filter(isFrameHost).map(refFor);
  return {
    ok: true,
    url: location.href,
    title: document.title,
    text: clipped.text,
    truncated: clipped.truncated || cut,
    frames,
  };
}
