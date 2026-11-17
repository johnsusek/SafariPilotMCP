import { isFrameHost } from "./frames";
import type { Failure, PageTextResult, TextFormat } from "../shared/protocol";
import { flatElements, isPruned } from "./flat";
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

let innerTextOf = (root: Element) =>
  ((root as HTMLElement).innerText ?? root.textContent ?? "")
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

  let text =
    format === "markdown" ? markdownOf(root, maxChars) : innerTextOf(root);
  let frames =
    ref === null || isPruned(root)
      ? []
      : [root, ...flatElements(root)].filter(isFrameHost).map(refFor);
  return {
    ok: true,
    url: location.href,
    title: document.title,
    ...clip(text, maxChars),
    frames,
  };
}
