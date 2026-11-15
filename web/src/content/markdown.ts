import { redactUrl } from "../shared/redact";
import { isField, nameOf, roleOf } from "./describe";
import { flatChildren, isBlock, isInvisible, isPruned, isShown } from "./flat";

// Markdown written so far: blocks are finished blocks and line the inline run being built. inline writes no block markup (a heading, a table cell, a link's text),
// inLink writes no nested link, and budget is how many more characters of text are wanted, shared by every sink of one read.
type Sink = {
  blocks: string[];
  line: string;
  inline: boolean;
  inLink: boolean;
  budget: { left: number };
};

let listTags = new Set(["ul", "ol", "menu"]);
// Their content is not page text: frames are read on their own, media fallback is never drawn.
let skippedTags = new Set([
  "iframe",
  "frame",
  "object",
  "embed",
  "video",
  "audio",
  "canvas",
]);

let nested = (sink: Sink, inline = sink.inline): Sink => ({
  blocks: [],
  line: "",
  inline,
  inLink: sink.inLink,
  budget: sink.budget,
});

function append(sink: Sink, text: string) {
  let clean = text.replace(/\s+/g, " ");

  if (clean.startsWith(" ") && (!sink.line || /[ \n]$/.test(sink.line)))
    clean = clean.slice(1);

  sink.line += clean;
  sink.budget.left -= clean.length;
}

function push(sink: Sink, block: string) {
  if (block) sink.blocks.push(block);
}

function flush(sink: Sink) {
  let lines = sink.line.split("\n").map((line) => line.trim());
  sink.line = "";
  push(sink, lines.filter(Boolean).join("\n"));
}

// Everything under node as one line.
function inlineText(node: Element, sink: Sink, inLink = sink.inLink) {
  let inner = { ...nested(sink, true), inLink };
  flow(node, inner);
  flush(inner);
  return inner.blocks.join(" ").replace(/\s+/g, " ").trim();
}

function flow(node: Node, sink: Sink, invisible = false) {
  for (let child of flatChildren(node)) {
    if (sink.budget.left <= 0) return;

    if (child.nodeType === Node.TEXT_NODE) {
      if (!invisible) append(sink, child.textContent ?? "");

      continue;
    }

    if (child instanceof Element) write(child, sink);
  }
}

// Text exactly as a pre shows it.
function rawText(node: Node, invisible = false): string {
  let parts: string[] = [];

  for (let child of flatChildren(node)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (!invisible) parts.push(child.textContent ?? "");

      continue;
    }

    if (!(child instanceof Element)) continue;

    if (child.localName === "br") {
      parts.push("\n");
      continue;
    }

    if (!isPruned(child)) parts.push(rawText(child, isInvisible(child)));
  }

  return parts.join("");
}

// Same-origin links as paths and others whole, secrets hidden either way; a javascript: link has none.
function hrefOf(anchor: HTMLAnchorElement) {
  if (!URL.canParse(anchor.href, location.href)) return null;

  let url = new URL(anchor.href, location.href);

  if (url.protocol === "javascript:") return null;

  let local = url.origin === location.origin && url.protocol.startsWith("http");
  return redactUrl(
    local ? `${url.pathname}${url.search}${url.hash}` : url.href,
  );
}

function heading(element: Element, sink: Sink) {
  let text = inlineText(element, sink);

  if (sink.inline) {
    append(sink, ` ${text} `);
    return;
  }

  let level =
    Number(
      element.getAttribute("aria-level") ??
        element.localName.match(/^h([1-6])$/)?.[1],
    ) || 2;
  flush(sink);
  push(sink, text && `${"#".repeat(Math.min(Math.max(level, 1), 6))} ${text}`);
}

function list(element: Element, sink: Sink) {
  if (sink.inline) {
    flow(element, sink, isInvisible(element));
    return;
  }

  flush(sink);
  let ordered = element.localName === "ol";
  let number = ordered ? (element as HTMLOListElement).start : 1;
  let lines: string[] = [];

  for (let child of flatChildren(element)) {
    if (!(child instanceof Element) || isPruned(child)) continue;

    let item = nested(sink);
    let isItem =
      child.localName === "li" || child.getAttribute("role") === "listitem";

    if (isItem) flow(child, item, isInvisible(child));
    else write(child, item);

    flush(item);
    let content = item.blocks.join("\n");

    if (!content) continue;

    let marker = ordered ? `${number++}. ` : "- ";
    let indent = " ".repeat(marker.length);
    lines.push(
      ...content
        .split("\n")
        .map((line, index) =>
          index === 0 ? `${marker}${line}` : line && `${indent}${line}`,
        ),
    );
  }

  push(sink, lines.join("\n"));
}

// A table that holds another table, or says it is for layout, lays out the page rather than data, so it reads as blocks.
let isDataTable = (table: HTMLTableElement) =>
  !/^(presentation|none)$/.test(table.getAttribute("role") ?? "") &&
  !table.querySelector("table");

function table(element: HTMLTableElement, sink: Sink) {
  if (sink.inline) {
    flow(element, sink);
    return;
  }

  flush(sink);
  let caption = element.caption;

  if (caption && isShown(caption)) push(sink, inlineText(caption, sink));

  let rows = Array.from(element.rows)
    .filter(isShown)
    .map((row) => {
      let cells = Array.from(row.cells)
        .filter(isShown)
        .flatMap((cell) => [
          inlineText(cell, sink).replace(/\|/g, "\\|"),
          ...Array<string>(Math.max(cell.colSpan - 1, 0)).fill(""),
        ]);

      while (cells.length && !cells.at(-1)) cells.pop();

      return cells;
    })
    .filter((cells) => cells.length);

  if (!rows.length) return;

  let width = Math.max(...rows.map((cells) => cells.length));
  let line = (cells: string[]) =>
    `| ${[...cells, ...Array<string>(width - cells.length).fill("")].join(" | ")} |`;
  push(
    sink,
    [
      line(rows[0]),
      line(Array<string>(width).fill("---")),
      ...rows.slice(1).map(line),
    ].join("\n"),
  );
}

function pre(element: Element, sink: Sink) {
  let text = rawText(element).replace(/\n+$/, "");

  if (sink.inline) {
    append(sink, ` ${text} `);
    return;
  }

  sink.budget.left -= text.length;
  let classes = `${element.className} ${element.querySelector("code")?.className ?? ""}`;
  let language = classes.match(/\b(?:language|lang)-([\w+#-]+)/)?.[1] ?? "";
  let fence = text.includes("```") ? "````" : "```";
  flush(sink);
  push(sink, text && `${fence}${language}\n${text}\n${fence}`);
}

function quote(element: Element, sink: Sink) {
  if (sink.inline) {
    flow(element, sink);
    return;
  }

  flush(sink);
  let inner = nested(sink);
  flow(element, inner);
  flush(inner);

  if (!inner.blocks.length) return;

  let lines = inner.blocks.join("\n\n").split("\n");
  push(sink, lines.map((line) => (line ? `> ${line}` : ">")).join("\n"));
}

function link(element: HTMLAnchorElement, sink: Sink) {
  if (sink.inLink) {
    flow(element, sink);
    return;
  }

  let text = inlineText(element, sink, true) || nameOf(element);
  let href = hrefOf(element);

  if (!text) return;

  let written = href === null ? text : `[${text}](${href})`;

  if (sink.inline || !isBlock(element)) {
    append(sink, written);
    return;
  }

  flush(sink);
  push(sink, written);
}

function write(element: Element, sink: Sink) {
  let tag = element.localName;

  if (tag === "br") {
    sink.line += sink.inline ? " " : "\n";
    return;
  }

  if (isPruned(element) || isField(element) || skippedTags.has(tag)) return;

  let role = roleOf(element);
  let isList = listTags.has(tag) || role === "list";

  // Its descendants can still show, but not its own text; a list writes none of its own.
  if (isInvisible(element) && !isList) {
    flow(element, sink, true);
    return;
  }

  if (role === "heading") return heading(element, sink);

  if (tag === "pre") return pre(element, sink);

  if (element instanceof HTMLTableElement && isDataTable(element))
    return table(element, sink);

  if (isList) return list(element, sink);

  if (tag === "blockquote") return quote(element, sink);

  if (element instanceof HTMLAnchorElement && element.hasAttribute("href"))
    return link(element, sink);

  if (role === "img") {
    let name = nameOf(element, false);

    if (name) append(sink, `![${name}]`);

    return;
  }

  if (tag === "hr") {
    if (sink.inline) return;

    flush(sink);
    push(sink, "---");
    return;
  }

  if (tag === "code") {
    let text = rawText(element).replace(/\s+/g, " ").trim();
    let tick = text.includes("`") ? "``" : "`";

    if (text) append(sink, `${tick}${text}${tick}`);

    return;
  }

  if (!isBlock(element)) {
    flow(element, sink);
    return;
  }

  if (sink.inline) {
    append(sink, " ");
    flow(element, sink);
    append(sink, " ");
    return;
  }

  flush(sink);
  flow(element, sink);
  flush(sink);
}

// root and what it shows as markdown, over the flat tree read_page walks: headings, lists, links, tables, code and quotes, no emphasis, images by their names,
// and no form field values or secret editors. Walking stops once more than maxChars of text is written.
export function markdownOf(root: Element, maxChars: number) {
  let sink: Sink = {
    blocks: [],
    line: "",
    inline: false,
    inLink: false,
    budget: { left: maxChars + 1 },
  };
  write(root, sink);
  flush(sink);
  return sink.blocks.join("\n\n");
}
