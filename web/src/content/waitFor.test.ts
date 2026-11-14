// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveRef } from "./refs";
import { shownText, waitFor } from "./waitFor";

beforeEach(() => {
  document.body.innerHTML = "";
  document.title = "Shop";
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: { scale: 1, offsetLeft: 0, offsetTop: 0, width: 1000, height: 800 },
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      let width = (this as HTMLElement).dataset?.empty ? 0 : 100;
      let top = Number((this as HTMLElement).dataset?.top ?? 10);
      return new DOMRect(10, top, width, 20);
    },
  );
});

let matched = (text: string | null, selector: string | null = null) => {
  let result = waitFor(text, selector);

  if (!result.ok) return result.error;

  return result.match && { tag: result.match.tag, text: result.match.text };
};

describe("waitFor text", () => {
  test("matches the deepest element holding the text, across inline elements", () => {
    document.body.innerHTML = "<p>Total: <b>42</b> items</p>";
    expect(matched("42")).toEqual({ tag: "b", text: "42" });
    expect(matched("42 items")).toEqual({ tag: "p", text: "Total: 42 items" });
  });

  test("ignores case and runs of whitespace", () => {
    document.body.innerHTML = "<h2>Search   results\n for cats</h2>";
    expect(matched("  RESULTS for\tcats ")).toEqual({
      tag: "h2",
      text: "Search results for cats",
    });
  });

  test("block boxes and br separate words", () => {
    document.body.innerHTML =
      "<div>Hello</div><div>World</div><p>one<br>two</p>";
    expect(matched("HelloWorld")).toBeNull();
    expect(matched("Hello World")).toEqual({
      tag: "body",
      text: "Hello World one two",
    });
    expect(matched("one two")).toEqual({ tag: "p", text: "one two" });
  });

  test("hidden text does not count, but a visible child of a visibility:hidden parent does", () => {
    document.body.innerHTML =
      '<div style="display: none">Done</div><div hidden>Done</div><div aria-hidden="true">Done</div><div style="visibility: hidden">Done <span style="visibility: visible">Ready</span></div>';
    expect(matched("done")).toBeNull();
    expect(matched("ready")).toEqual({ tag: "span", text: "Ready" });
  });

  test("form field values do not count", () => {
    document.body.innerHTML =
      '<input value="Saved"><textarea>Saved</textarea><select><option>Saved</option></select>';
    expect(matched("saved")).toBeNull();
  });

  test("text in a shadow root counts", () => {
    document.body.innerHTML = "<x-card></x-card>";
    let root = document.querySelector("x-card")!.attachShadow({ mode: "open" });
    root.innerHTML = "<em>Shipped</em>";
    expect(matched("shipped")).toEqual({ tag: "em", text: "Shipped" });
  });

  test("an element without a box gives way to the nearest one with a box", () => {
    document.body.innerHTML = '<div><span data-empty="1">Loaded</span></div>';
    expect(matched("loaded")).toEqual({ tag: "div", text: "Loaded" });
  });

  test("the match carries a ref that resolves and the page's address", () => {
    document.body.innerHTML = '<button data-top="5000">Continue</button>';
    let result = waitFor("continue", null);
    expect(result).toMatchObject({
      ok: true,
      title: "Shop",
      match: { role: "button", name: "Continue", inViewport: false },
    });

    if (!result.ok || !result.match) return;

    expect(resolveRef(result.match.ref)).toBe(document.querySelector("button"));
  });

  test("shownText collapses whitespace once at element edges", () => {
    document.body.innerHTML = "<div> a </div><div> b </div>";
    expect(shownText(document.body).text).toBe("a b ");
  });
});

describe("waitFor selector", () => {
  test("returns the first shown match with a box, in document order", () => {
    document.body.innerHTML =
      '<li class="row" hidden>Gone</li><li class="row" data-empty="1">Empty</li><li class="row">First</li><li class="row">Second</li>';
    expect(matched(null, "li.row")).toEqual({ tag: "li", text: "First" });
  });

  test("nothing shown yet is null, not a failure", () => {
    document.body.innerHTML = '<div id="results" style="display: none"></div>';
    expect(matched(null, "#results")).toBeNull();
  });

  test("an invalid selector fails", () => {
    expect(matched(null, "li[")).toBe('"li[" is not a valid CSS selector');
  });

  test("takes exactly one of text and selector", () => {
    expect(matched(null, null)).toBe("waitFor takes either text or selector");
    expect(matched("a", "b")).toBe("waitFor takes either text or selector");
  });
});

describe("waitFor secrets", () => {
  test("a selector match on a field or a secret editor shows none of its text", () => {
    document.body.innerHTML =
      '<textarea id="note" name="api_token">sk-live-abc</textarea><div id="pass" contenteditable="true" aria-label="Password">hunter2</div><p>Signed in</p>';
    expect(matched(null, "#note")).toEqual({ tag: "textarea", text: "" });
    expect(matched(null, "#pass")).toEqual({ tag: "div", text: "" });
    expect(shownText(document.body).text.trim()).toBe("Signed in");
  });
});
