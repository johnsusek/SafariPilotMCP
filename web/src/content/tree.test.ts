// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveRef } from "./refs";
import { treeText } from "./tree";

let render = (html: string, filter: "all" | "interactive" = "all") => {
  document.body.innerHTML = html;
  return treeText(document.body, filter, 10000);
};

let withoutRefs = (text: string) => text.replace(/ \[ref=\d+\]/g, "");

beforeEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("treeText", () => {
  test("indents children, collapses wrappers and merges inline text", () => {
    let { text, truncated } = render(
      '<nav><ul><li><a href="/docs">Docs</a></li></ul></nav><div><div><p>Hello <b>big</b> world</p></div></div><h2>Title</h2>',
    );
    expect(truncated).toBe(false);
    expect(withoutRefs(text)).toBe(
      [
        "navigation",
        "  list",
        "    listitem",
        '      link "Docs" href=/docs',
        'paragraph "Hello big world"',
        'heading "Title" level=2',
      ].join("\n"),
    );
  });

  test("refs resolve to the rendered elements", () => {
    let { text } = render('<button id="go">Go</button>');
    let ref = Number(text.match(/\[ref=(\d+)\]/)![1]);
    expect(resolveRef(ref)).toBe(document.getElementById("go"));
  });

  test("text runs stay beside elements they surround", () => {
    let { text } = render('<p>Read <a href="#x">this</a> now</p>');
    expect(withoutRefs(text)).toBe(
      ["paragraph", '  "Read"', '  link "this" href=/#x', '  "now"'].join("\n"),
    );
  });

  test("skips hidden, aria-hidden and script content", () => {
    let { text } = render(
      '<div hidden>gone</div><div style="display: none">gone</div><div aria-hidden="true"><button>gone</button></div><script>gone()</script><span>kept</span>',
    );
    expect(text).toBe('"kept"');
  });

  test("states and values, never password values", () => {
    let { text } = render(
      '<input type="checkbox" checked aria-label="Agree"><button disabled>Send</button><input aria-label="Email" value="me@example.com" required><input type="password" aria-label="Password" value="hunter2"><select aria-label="Size"><option>S</option><option selected>M</option></select><button aria-expanded="false">More</button>',
    );
    expect(withoutRefs(text)).toBe(
      [
        'checkbox "Agree" checked',
        'button "Send" disabled',
        'textbox "Email" required value="me@example.com"',
        'textbox "Password"',
        'combobox "Size" value="M"',
        'button "More" collapsed',
      ].join("\n"),
    );
    expect(text).not.toContain("hunter2");
  });

  test("long values and offsite links are shortened", () => {
    let { text } = render(
      `<textarea aria-label="Note">${"x".repeat(100)}</textarea><a href="https://example.org/a/b?c=1">Out</a>`,
    );
    let [note, link] = withoutRefs(text).split("\n");
    expect(note).toBe(`textbox "Note" value="${"x".repeat(37)}..."`);
    expect(link).toBe('link "Out" href=example.org/a/b?c=1');
  });

  test("walks open shadow roots and slots", () => {
    document.body.innerHTML = '<div id="host"><span>slotted</span></div>';
    let shadow = document
      .getElementById("host")!
      .attachShadow({ mode: "open" });
    shadow.innerHTML = "<button>Inner</button><slot></slot>";
    let { text } = treeText(document.body, "all", 10000);
    expect(withoutRefs(text)).toBe(['button "Inner"', '"slotted"'].join("\n"));
  });

  test("decorative images are dropped, named ones kept", () => {
    let { text } = render('<img alt=""><img alt="Logo">');
    expect(withoutRefs(text)).toBe('img "Logo"');
  });

  test("interactive filter keeps only actionable elements", () => {
    let { text } = render(
      '<h1>Shop</h1><p>Intro <a href="/cart">Cart</a></p><div><input aria-label="Search"></div>',
      "interactive",
    );
    expect(withoutRefs(text)).toBe(
      ['link "Cart" href=/cart', 'textbox "Search"'].join("\n"),
    );
  });

  test("maxChars cuts at a line boundary", () => {
    document.body.innerHTML = "<p>one</p><p>two</p><p>three</p>";
    let full = treeText(document.body, "all", 10000).text;
    let secondEnd = full.split("\n").slice(0, 2).join("\n").length;
    let cut = treeText(document.body, "all", secondEnd + 3);
    expect(cut.truncated).toBe(true);
    expect(cut.text.split("\n")).toHaveLength(2);
    expect(cut.text.length).toBeLessThanOrEqual(secondEnd + 3);
  });
});
