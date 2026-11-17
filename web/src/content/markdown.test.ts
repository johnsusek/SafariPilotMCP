// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PageTextResult } from "../shared/protocol";
import { markdownOf } from "./markdown";
import { pageText } from "./pageText";
import { refFor } from "./refs";

let markdown = (html: string, maxChars = 10000) => {
  document.body.innerHTML = html;
  return markdownOf(document.body, maxChars).text;
};

let read = (element: Element, maxChars = 10000) =>
  pageText(maxChars, "markdown", refFor(element)) as PageTextResult;

beforeEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("markdownOf", () => {
  test("headings, paragraphs, inline links, code and line breaks", () => {
    expect(
      markdown(
        '<h1>Title</h1><div role="heading" aria-level="3">Sub</div><p>Read <a href="/docs?q=1#top">the docs</a> or <a href="https://other.example/x">this</a>, run <code>npm test</code>.</p><p>One<br>Two</p>',
      ),
    ).toBe(
      [
        "# Title",
        "### Sub",
        "Read [the docs](/docs?q=1#top) or [this](https://other.example/x), run `npm test`.",
        "One\nTwo",
      ].join("\n\n"),
    );
  });

  test("link targets hide secrets, and a javascript: link is only its text", () => {
    expect(
      markdown(
        '<p><a href="https://example.org/reset?token=abc123&lang=en">Reset</a> <a href="https://u:pw@example.org/">In</a> <a href="javascript:void(0)">Menu</a> <a href="/x" aria-label="Close"><svg></svg></a></p>',
      ),
    ).toBe(
      "[Reset](https://example.org/reset?token=[hidden]&lang=en) [In](https://[hidden]@example.org/) Menu [Close](/x)",
    );
  });

  test("nested and numbered lists", () => {
    expect(
      markdown(
        '<ul><li>Fruit<ul><li>Apple</li><li><a href="/pear">Pear</a></li></ul></li><li>Bread</li></ul><ol start="3"><li><p>Third</p><p>more</p></li><li hidden>Gone</li><li>Fourth</li></ol>',
      ),
    ).toBe(
      [
        "- Fruit\n  - Apple\n  - [Pear](/pear)\n- Bread",
        "3. Third\n   more\n4. Fourth",
      ].join("\n\n"),
    );
  });

  test("a data table becomes a markdown table: header row, spans, escaped pipes and backslashes, links", () => {
    expect(
      markdown(
        '<table><caption>Plans</caption><thead><tr><th>Plan</th><th>Price</th><th>Note</th></tr></thead><tbody><tr><td><a href="/pro">Pro</a></td><td>$5 | mo</td><td>Best</td></tr><tr style="display: none"><td>Old</td></tr><tr><td colspan="2">Team</td><td>Soon</td></tr><tr><td>Free</td><td>a\\|b</td><td>C:\\</td></tr></tbody></table>',
      ),
    ).toBe(
      [
        "Plans",
        [
          "| Plan | Price | Note |",
          "| --- | --- | --- |",
          "| [Pro](/pro) | $5 \\| mo | Best |",
          "| Team |  | Soon |",
          "| Free | a\\\\\\|b | C:\\\\ |",
        ].join("\n"),
      ].join("\n\n"),
    );
  });

  test("an ARIA grid becomes a markdown table: pinned parts join by row index, cells sort by column index, and unrendered rows are counted", () => {
    expect(
      markdown(
        '<div role="grid" aria-rowcount="100"><div role="rowgroup"><div role="row" aria-rowindex="1"><span role="columnheader" aria-colindex="2">Name</span><span role="columnheader" aria-colindex="3">CPU</span></div><div role="row" aria-rowindex="2"><span role="gridcell" aria-colindex="2">Chrome</span><span role="gridcell" aria-colindex="3">7%</span></div></div><div role="rowgroup"><div role="row" aria-rowindex="1"><span role="columnheader" aria-colindex="1">#</span></div><div role="row" aria-rowindex="2"><span role="rowheader" aria-colindex="1">1</span></div><div role="row" aria-rowindex="3"><span role="gridcell"><input aria-label="Filter"></span></div></div></div><div role="table"><div role="row"><span role="cell">a | b</span><span role="cell">c</span></div></div>',
      ),
    ).toBe(
      [
        "| # | Name | CPU |\n| --- | --- | --- |\n| 1 | Chrome | 7% |",
        "(3 of the grid's 100 rows are rendered; scrolling the grid renders others)",
        "| a \\| b | c |\n| --- | --- |",
      ].join("\n\n"),
    );
  });

  test("checkboxes show their state, and repeated images read once", () => {
    expect(
      markdown(
        '<table><tr><th>Name</th><th>Bought</th><th>Rating</th></tr><tr><td>Tony</td><td><input type="checkbox" checked></td><td><img alt="2 stars"><img alt="2 stars"></td></tr></table><label><input type="checkbox"> Remember me</label>',
      ),
    ).toBe(
      "| Name | Bought | Rating |\n| --- | --- | --- |\n| Tony | [x] | ![2 stars] |\n\n[ ] Remember me",
    );
  });

  test("a table holding a table, or marked as layout, reads as blocks around the data table inside", () => {
    let text = markdown(
      '<table><tr><td>Side</td><td><table><tr><td>Inner</td></tr></table></td></tr></table><table role="presentation"><tr><td>Layout</td></tr></table>',
    );
    expect(text).toMatch(/^Side/);
    expect(text).toContain("| Inner |\n| --- |");
    expect(text).toMatch(/\n\nLayout$/);
  });

  test("code blocks keep their text and language, quotes and rules their marks", () => {
    expect(
      markdown(
        '<pre class="language-js"><code><span>let</span> a = 1;\n  b();\n</code></pre><blockquote><p>Said</p><p>twice</p></blockquote><hr><pre>x ``` y</pre>',
      ),
    ).toBe(
      [
        "```js\nlet a = 1;\n  b();\n```",
        "> Said\n>\n> twice",
        "---",
        "````\nx ``` y\n````",
      ].join("\n\n"),
    );
  });

  test("images by their names; a card link is its own block with its heading as text", () => {
    expect(
      markdown(
        '<p>Logo <img alt="Acme" src="/a.png"> <img alt="" src="/spacer.gif"> <svg></svg></p><a href="/post" style="display: block"><h3>Post</h3><p>Summary</p></a><a href="/"><img alt="Home"></a>',
      ),
    ).toBe(
      ["Logo ![Acme]", "[Post Summary](/post)", "[![Home]](/)"].join("\n\n"),
    );
  });

  test("skips hidden content, keeps a visible child of a visibility:hidden parent", () => {
    expect(
      markdown(
        '<div hidden>gone</div><p style="display: none">gone</p><div aria-hidden="true">gone</div><script>gone()</script><ul style="visibility: hidden">gone<li style="visibility: visible">Shown</li><li>Hidden</li></ul><p>kept</p>',
      ),
    ).toBe(["- Shown", "kept"].join("\n\n"));
  });

  test("walks open shadow roots and slots", () => {
    document.body.innerHTML =
      '<x-card><span slot="title">Slotted</span></x-card>';
    let host = document.querySelector("x-card")!;
    host.attachShadow({ mode: "open" }).innerHTML =
      '<h2><slot name="title"></slot></h2><p>From the shadow</p>';
    expect(markdownOf(document.body, 10000).text).toBe(
      "## Slotted\n\nFrom the shadow",
    );
  });

  test("form field values and secret editors never show", () => {
    let text = markdown(
      '<p>Sign in</p><input type="password" value="hunter2"><input value="me@example.com"><textarea>draft</textarea><select><option>Opt</option></select><div contenteditable="true" aria-label="Recovery passphrase">correct horse</div><div contenteditable="true">Public note</div>',
    );
    expect(text).toBe(["Sign in", "Public note"].join("\n\n"));
  });

  test("stops walking once more than maxChars of text is written", () => {
    let rows = Array.from({ length: 500 }, (_, index) => `<p>Row ${index}</p>`);
    let text = markdown(rows.join(""), 50);
    expect(text.length).toBeLessThan(200);
    expect(text.startsWith("Row 0\n\nRow 1")).toBe(true);
  });
});

describe("pageText", () => {
  let page =
    '<nav id="nav"><ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul></nav><main><h1>Main</h1><table id="table"><tr><th>K</th><th>V</th></tr><tr><td>x</td><td>1</td></tr><tr><td>y</td><td>2</td></tr></table></main>';

  test("markdown reads the main content, like text", () => {
    document.body.innerHTML = page;
    let result = pageText(10000, "markdown", null) as PageTextResult;
    expect(result.text).toBe(
      "# Main\n\n| K | V |\n| --- | --- |\n| x | 1 |\n| y | 2 |",
    );
    expect(result.frames).toEqual([]);
  });

  test("a table ref returns just that table, a nav ref just its links", () => {
    document.body.innerHTML = page;
    expect(read(document.getElementById("table")!).text).toBe(
      "| K | V |\n| --- | --- |\n| x | 1 |\n| y | 2 |",
    );
    expect(read(document.getElementById("nav")!).text).toBe(
      "- [A](/a)\n- [B](/b)",
    );
    expect(
      (
        pageText(
          10000,
          "text",
          refFor(document.getElementById("nav")!),
        ) as PageTextResult
      ).text,
    ).toMatch(/^A\s*B$/);
  });

  test("max_chars cuts a table on a row boundary", () => {
    document.body.innerHTML = page;
    let result = read(document.getElementById("table")!, 40);
    expect(result).toMatchObject({
      text: "| K | V |\n| --- | --- |\n| x | 1 |",
      truncated: true,
    });
  });

  test("a read the text budget cut short says so though it ends under max_chars", () => {
    document.body.innerHTML = `<div role="grid">${Array.from(
      { length: 30 },
      (_, index) =>
        `<div role="row"><span role="gridcell">Row ${index} with some longer text</span></div>`,
    ).join("")}</div>`;
    let result = read(document.body, 200);
    expect(result.text.length).toBeLessThanOrEqual(200);
    expect(result.truncated).toBe(true);
  });

  test("a ref names the frames inside it, itself included", () => {
    vi.stubGlobal("browser", { runtime: { getFrameId: () => 7 } });
    document.body.innerHTML =
      '<section id="box"><p>Around</p><iframe id="inner" title="Inner"></iframe></section><iframe id="other"></iframe>';
    let inner = document.getElementById("inner")!;
    expect(read(document.getElementById("box")!).frames).toEqual([
      refFor(inner),
    ]);
    expect(read(inner).frames).toEqual([refFor(inner)]);
  });

  test("an unknown ref fails", () => {
    expect(pageText(100, "markdown", 99999)).toMatchObject({
      ok: false,
      code: "stale_ref",
    });
  });
});
