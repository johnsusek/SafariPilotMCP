import type { PageTextResult } from "../shared/protocol";

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

export function pageText(maxChars: number): PageTextResult {
  let text = textRoot()
    .innerText.split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    ok: true,
    url: location.href,
    title: document.title,
    ...clip(text, maxChars),
  };
}
