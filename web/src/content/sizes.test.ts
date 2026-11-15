// @vitest-environment happy-dom
// Output sizes, in characters, of the leaner reads against the reads they replace; DECISIONS.md records these numbers.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PageTextResult, ReadPageResult } from "../shared/protocol";
import { pageText } from "./pageText";
import { refFor } from "./refs";
import { readPage } from "./tree";

let tree = (viewport: boolean, ref: number | null = null) =>
  (readPage("all", 1e6, ref, null, "", viewport, null) as ReadPageResult).text;
let text = (format: "text" | "markdown", ref: number | null) =>
  (pageText(1e6, format, ref) as PageTextResult).text;

beforeEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: { scale: 1, offsetLeft: 0, offsetTop: 0, width: 1000, height: 800 },
  });
});

describe("sizes", () => {
  test("a viewport read of a long page against the whole page", () => {
    // 200 sections of 500 px, scrolled to the fifth; each element and text run takes its section's box.
    document.body.innerHTML = Array.from(
      { length: 200 },
      (_, index) =>
        `<section data-top="${index * 500 - 2000}"><h2>Section ${index}</h2><p>Paragraph ${index} explains what this part of the page is about in a sentence or two of ordinary prose.</p><ul><li><a href="/s/${index}/one">First link</a></li><li><a href="/s/${index}/two">Second link</a></li></ul><button>Act on ${index}</button></section>`,
    ).join("");
    let boxOf = (node: Node | null) => {
      let section = (
        node instanceof Element ? node : node?.parentElement
      )?.closest("section");
      return section
        ? new DOMRect(0, Number(section.dataset.top), 1000, 500)
        : new DOMRect(0, -2000, 1000, 100000);
    };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        return boxOf(this);
      },
    );
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Range) {
        return boxOf(this.startContainer);
      },
    );
    let whole = tree(false).length;
    let viewport = tree(true).length;
    expect({ whole, viewport }).toMatchInlineSnapshot(`
      {
        "viewport": 717,
        "whole": 73249,
      }
    `);
    expect(viewport).toBeLessThan(whole / 50);
  });

  test("markdown of a table and a link list against text and read_page", () => {
    document.body.innerHTML = `<main><table id="table"><tr><th>Name</th><th>Region</th><th>Users</th><th>Status</th></tr>${Array.from(
      { length: 50 },
      (_, index) =>
        `<tr><td><a href="/accounts/${index}">Account ${index}</a></td><td>Region ${index % 5}</td><td>${index * 37}</td><td>Active</td></tr>`,
    ).join("")}</table><nav id="links"><ul>${Array.from(
      { length: 100 },
      (_, index) =>
        `<li><a href="/docs/topic-${index}">Topic ${index}</a></li>`,
    ).join("")}</ul></nav></main>`;
    let table = refFor(document.getElementById("table")!);
    let links = refFor(document.getElementById("links")!);
    let sizes = {
      table: {
        text: text("text", table).length,
        markdown: text("markdown", table).length,
        readPage: tree(false, table).length,
      },
      links: {
        text: text("text", links).length,
        markdown: text("markdown", links).length,
        readPage: tree(false, links).length,
      },
      page: {
        text: text("text", null).length,
        markdown: text("markdown", null).length,
      },
    };
    expect(sizes).toMatchInlineSnapshot(`
      {
        "links": {
          "markdown": 2879,
          "readPage": 8123,
          "text": 790,
        },
        "page": {
          "markdown": 5789,
          "text": 2170,
        },
        "table": {
          "markdown": 2908,
          "readPage": 9588,
          "text": 1379,
        },
      }
    `);
    expect(sizes.table.markdown).toBeLessThan(sizes.table.readPage / 2);
    expect(sizes.links.markdown).toBeLessThan(sizes.links.readPage / 2);
    expect(text("markdown", links)).toContain("[Topic 99](/docs/topic-99)");
    expect(text("text", links)).not.toContain("/docs/");
  });
});
