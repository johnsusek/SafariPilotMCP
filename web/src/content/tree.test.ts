// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveRef } from "./refs";
import { readPage, treeText } from "./tree";

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

  test("visible children of a visibility:hidden parent are kept, its own text is not", () => {
    let { text } = render(
      '<ul role="menu" style="visibility: hidden">gone<li role="menuitem" style="visibility: visible">Top</li><li role="menuitem">Hidden</li></ul><div style="visibility: hidden"><button>Gone</button></div>',
    );
    expect(withoutRefs(text)).toBe('menuitem "Top"');
  });

  test("states and values, a password's only as hidden", () => {
    let { text } = render(
      '<input type="checkbox" checked aria-label="Agree"><button disabled>Send</button><input aria-label="Email" value="me@example.com" required><input type="password" aria-label="Password" value="hunter2"><select aria-label="Size"><option>S</option><option selected>M</option></select><button aria-expanded="false">More</button>',
    );
    expect(withoutRefs(text)).toBe(
      [
        'checkbox "Agree" checked',
        'button "Send" disabled',
        'textbox "Email" required value="me@example.com"',
        'textbox "Password" value=[hidden]',
        'combobox "Size" value="M"',
        'button "More" collapsed',
      ].join("\n"),
    );
    expect(text).not.toContain("hunter2");
  });

  test("secret fields show that they hold a value, never the value", () => {
    let { text } = render(
      '<input autocomplete="one-time-code" aria-label="Code" value="482913"><label>Card number <input value="4111111111111111"></label><textarea name="api_token">sk-live-abc</textarea><div contenteditable="true" aria-label="Recovery passphrase">correct horse</div><input name="cvv" value=""><input aria-label="City" value="Lisbon">',
    );
    expect(withoutRefs(text)).toBe(
      [
        'textbox "Code" value=[hidden]',
        'textbox "Card number" value=[hidden]',
        "textbox value=[hidden]",
        'textbox "Recovery passphrase" value=[hidden]',
        "textbox",
        'textbox "City" value="Lisbon"',
      ].join("\n"),
    );

    for (let secret of ["482913", "4111", "sk-live", "horse"])
      expect(text).not.toContain(secret);
  });

  test("link targets hide credentials in their URL", () => {
    let { text } = render(
      '<a href="https://example.org/reset?token=abc123&lang=en">Reset</a><a href="/cb#access_token=xyz">Back</a><a href="https://u:pw@example.org/">In</a>',
    );
    expect(withoutRefs(text)).toBe(
      [
        'link "Reset" href=example.org/reset?token=[hidden]&lang=en',
        'link "Back" href=/cb#access_token=[hidden]',
        'link "In" href=example.org/',
      ].join("\n"),
    );
  });

  test("file inputs show their type, what they take and the chosen files", () => {
    let { text } = render(
      '<input type="file" aria-label="Photos" multiple accept="image/*"><input id="one" type="file" aria-label="Resume"><input id="bare" type="file">',
    );
    expect(withoutRefs(text)).toBe(
      [
        'button "Photos" type=file multiple accept="image/*"',
        'button "Resume" type=file',
        "button type=file",
      ].join("\n"),
    );
    let transfer = new DataTransfer();
    transfer.items.add(new File(["a"], "cv.pdf"));

    for (let id of ["one", "bare"])
      (document.getElementById(id) as HTMLInputElement).files = transfer.files;

    // A file input's value is a fake path, never its name.
    expect(
      withoutRefs(treeText(document.body, "all", 10000).text)
        .split("\n")
        .slice(1),
    ).toEqual([
      'button "Resume" type=file value="cv.pdf"',
      'button type=file value="cv.pdf"',
    ]);
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

  test("cells and headings show their content as children, empty rows go", () => {
    let { text } = render(
      '<table><tr><td>Top <a href="/new">new</a></td></tr><tr></tr><tr><td>plain</td></tr></table><h2>Intro <a href="#e">edit</a></h2>',
    );
    expect(withoutRefs(text)).toBe(
      [
        "table",
        "  row",
        "    cell",
        '      "Top"',
        '      link "new" href=/new',
        "  row",
        '    cell "plain"',
        "heading level=2",
        '  "Intro"',
        '  link "edit" href=/#e',
      ].join("\n"),
    );
  });

  test("a focusable generic wrapping elements takes no name from them", () => {
    let { text } = render(
      '<div tabindex="0">Repo <a href="/star">Star</a><a href="/fork">Fork</a></div>',
      "interactive",
    );
    expect(withoutRefs(text)).toBe(
      ["generic", '  link "Star" href=/star', '  link "Fork" href=/fork'].join(
        "\n",
      ),
    );
  });

  test("a clickable group takes no name from the widgets it wraps", () => {
    let { text } = render(
      '<div role="group" tabindex="0"><img alt="Dune" src="x.png"><a href="/dune">Dune</a></div>',
      "interactive",
    );
    expect(withoutRefs(text)).toBe(
      ["group", '  link "Dune" href=/dune'].join("\n"),
    );
  });

  test("a nameless clickable wrapper around one element gives it up", () => {
    let { text } = render(
      '<div tabindex="0">Select occupancy <button>2 adults</button></div>',
    );
    expect(withoutRefs(text)).toBe(
      ['"Select occupancy"', 'button "2 adults"'].join("\n"),
    );
  });

  test("a pointer-cursor element inside a widget is not a second target", () => {
    let { text } = render(
      '<ul role="listbox"><li role="option"><div style="cursor: pointer">Lisbon</div></li></ul>',
      "interactive",
    );
    expect(withoutRefs(text)).toBe(["listbox", '  option "Lisbon"'].join("\n"));
  });

  test("an option holding a link of the same name shows as the link", () => {
    let { text } = render(
      '<ul role="listbox"><li role="option"><a href="/dune">Dune 2021</a></li></ul>',
      "interactive",
    );
    expect(withoutRefs(text)).toBe(
      ["listbox", '  link "Dune 2021" href=/dune'].join("\n"),
    );
  });

  test("a gridcell holding one button of its text shows as the button", () => {
    let { text } = render(
      '<div role="grid"><div role="row"><div role="gridcell" style="cursor: pointer"><div role="button" tabindex="0">usb c cable</div></div></div></div>',
      "interactive",
    );
    expect(withoutRefs(text)).toBe('button "usb c cable"');
  });

  test("a link around an image of the same name keeps the link", () => {
    let { text } = render('<a href="/home"><img alt="Home" src="x.png"></a>');
    expect(withoutRefs(text)).toBe(
      ['link "Home" href=/home', '  img "Home"'].join("\n"),
    );
  });

  test("a focusable container is not named by its content", () => {
    let { text } = render(
      '<div role="tabpanel" tabindex="0"><img alt="Godzilla"><b>Godzilla</b> <span>7.9</span></div>',
      "interactive",
    );
    expect(withoutRefs(text)).toBe("tabpanel");
  });

  test("a clickable label beside its shown control is left out", () => {
    let { text } = render(
      '<input type="checkbox" id="work"><label for="work" style="cursor: pointer">Work trip</label><input type="radio" id="gone" style="display: none"><label for="gone" style="cursor: pointer">Hidden radio</label>',
      "interactive",
    );
    expect(withoutRefs(text)).toBe(
      ['checkbox "Work trip"', 'generic "Hidden radio"'].join("\n"),
    );
  });

  test("an editor is one textbox showing its text as value", () => {
    let { text } = render(
      '<div contenteditable="true" aria-label="Code"><div><span>let</span> <span>x</span></div></div>',
    );
    expect(withoutRefs(text)).toBe('textbox "Code" value="let x"');
  });

  test("label and legend text is not repeated beside what it names", () => {
    let { text } = render(
      '<fieldset><legend>Size</legend><label><input type="radio"> Small</label></fieldset><label for="n">Name <b>*</b></label><input id="n">',
    );
    expect(withoutRefs(text)).toBe(
      ['group "Size"', '  radio "Small"', 'textbox "Name *"'].join("\n"),
    );
  });

  test("a caption names its table and a br separates words", () => {
    let { text } = render(
      "<table><caption>Share</caption><tr><th>Stat<br>2026</th></tr></table>",
    );
    expect(withoutRefs(text)).toBe(
      ['table "Share"', "  row", '    columnheader "Stat 2026"'].join("\n"),
    );
  });

  test("a widget wrapping the same widget shows once", () => {
    let { text } = render(
      '<div role="button" tabindex="0"><button>Next</button></div>',
    );
    expect(withoutRefs(text)).toBe('button "Next"');
  });

  test("links take a descendant's title when it has no text", () => {
    let { text } = render('<a href="/vote"><div title="upvote"></div></a>');
    expect(withoutRefs(text)).toBe('link "upvote" href=/vote');
  });

  test("a short read of a long page stops walking early and gives the same prefix", () => {
    document.body.innerHTML = Array.from(
      { length: 2000 },
      (_, index) => `<p>Paragraph ${index}</p>`,
    ).join("");
    let full = treeText(document.body, "all", 1e9).text;
    let paragraphs = document.querySelectorAll("p");
    let spy = vi.spyOn(paragraphs[1999], "checkVisibility");
    let short = treeText(document.body, "all", 200);
    expect(short.truncated).toBe(true);
    expect(full.startsWith(short.text)).toBe(true);
    expect(short.text.length).toBeGreaterThan(150);
    expect(spy).not.toHaveBeenCalled();
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

describe("readPage", () => {
  beforeEach(() => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        scale: 1,
        offsetLeft: 0,
        offsetTop: 0,
        width: 1000,
        height: 800,
      },
    });
  });

  let html =
    '<nav id="menu"><ul><li><a href="/docs">Docs</a></li></ul></nav><h2>Title</h2>';

  test("depth limits the levels shown", () => {
    document.body.innerHTML = html;
    let result = readPage("all", 10000, null, 2, "");
    expect(result.ok && withoutRefs(result.text)).toBe(
      ["navigation", "  list", 'heading "Title" level=2'].join("\n"),
    );
  });

  test("ref limits the tree to that element", () => {
    document.body.innerHTML = html;
    let ref = Number(
      treeText(document.body, "all", 10000).text.match(/\[ref=(\d+)\]/)![1],
    );
    let result = readPage("all", 10000, ref, null, "");
    expect(result.ok && withoutRefs(result.text)).toBe(
      [
        "navigation",
        "  list",
        "    listitem",
        '      link "Docs" href=/docs',
      ].join("\n"),
    );
  });

  test("unknown ref fails", () => {
    expect(readPage("all", 10000, 99999, null, "")).toEqual({
      ok: false,
      error: "ref 99999 is unknown",
    });
  });
});

describe("iframes", () => {
  let frameIds = (ids: Record<string, number>) =>
    vi.stubGlobal("browser", {
      runtime: { getFrameId: (target: Element) => ids[target.id] ?? -1 },
    });

  test("an iframe with a frame stays under interactive, prefixed, and marks its line", () => {
    frameIds({ live: 42 });
    document.body.innerHTML =
      '<p>Text</p><iframe id="live" title="Live sample" srcdoc="x"></iframe><iframe id="cold" title="Cold"></iframe><button>Go</button>';
    let { text, frames } = treeText(
      document.body,
      "interactive",
      10000,
      Infinity,
      "5:",
    );
    let lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^iframe "Live sample" \[ref=5:(\d+)\] srcdoc$/);
    expect(lines[1]).toMatch(/^button "Go" \[ref=5:\d+\]$/);
    let ref = Number(lines[0].match(/ref=5:(\d+)/)![1]);
    expect(resolveRef(ref)).toBe(document.getElementById("live"));
    expect(frames).toEqual([
      { ref, frameId: 42, line: 0, depth: 0, width: 0, height: 0 },
    ]);
  });

  test("an iframe with a frame stays under all even when its role is presentation", () => {
    frameIds({ widget: 9 });
    document.body.innerHTML =
      '<div><iframe id="widget" role="presentation" title="Widget"></iframe></div>';
    let { text, frames } = treeText(document.body, "all", 10000);
    expect(text).toMatch(/\[ref=\d+\]/);
    expect(frames).toMatchObject([{ frameId: 9 }]);
  });

  test("unloaded and sandboxed frames say so", () => {
    frameIds({ boxed: 7 });
    document.body.innerHTML =
      '<main><iframe id="cold" title="Cold"></iframe><iframe id="boxed" title="Boxed" sandbox="allow-same-origin"></iframe></main>';
    let { text, frames } = treeText(document.body, "all", 10000);
    expect(withoutRefs(text)).toBe(
      [
        "main",
        '  iframe "Cold" (frame not loaded)',
        '  iframe "Boxed" sandboxed',
      ].join("\n"),
    );
    expect(frames).toMatchObject([{ frameId: 7, line: 2, depth: 1 }]);
  });
});
