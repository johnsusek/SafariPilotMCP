// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { refFor } from "./refs";
import { scroll, scrollIntoView, scrollTarget } from "./scroll";

let overflowing = (element: HTMLElement) => {
  Object.defineProperty(element, "scrollHeight", { value: 1000 });
  Object.defineProperty(element, "clientHeight", { value: 100 });
  Object.defineProperty(element, "scrollWidth", { value: 100 });
  Object.defineProperty(element, "clientWidth", { value: 100 });
};

beforeEach(() => {
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: { scale: 1, offsetLeft: 0, offsetTop: 0, width: 1000, height: 800 },
  });
  document.body.innerHTML =
    '<div id="outer" style="overflow-x: hidden; overflow-y: auto"><div id="inner" style="overflow-x: hidden; overflow-y: hidden"><button>Go</button></div></div>';
  overflowing(document.getElementById("outer")!);
  overflowing(document.getElementById("inner")!);
});

let page = () => document.scrollingElement ?? document.documentElement;

describe("scrollTarget", () => {
  test("nearest ancestor with scrollable overflow on the requested axis", () => {
    let button = document.querySelector("button")!;
    expect(scrollTarget(button, 0, 50)).toBe(document.getElementById("outer"));
  });

  test("an axis with no overflow falls through to the document", () => {
    let button = document.querySelector("button")!;
    expect(scrollTarget(button, 50, 0)).toBe(page());
  });

  test("null ref scrolls the document", () => {
    expect(scrollTarget(null, 0, 50)).toBe(page());
  });

  test("crosses shadow roots to the host's scroller", () => {
    let host = document.createElement("div");
    document.getElementById("outer")!.append(host);
    let shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<button>Inner</button>";
    expect(scrollTarget(shadow.querySelector("button"), 0, 50)).toBe(
      document.getElementById("outer"),
    );
  });
});

describe("scroll", () => {
  test("reports movement of the chosen scroller", () => {
    let result = scroll(refFor(document.querySelector("button")!), 0, 40);
    expect(result.ok && result.moved).toBe(true);
    expect(document.getElementById("outer")!.scrollTop).toBe(40);
  });

  test("unknown ref fails", () => {
    expect(scroll(99999, 0, 40)).toEqual({
      ok: false,
      error: "ref 99999 is unknown",
    });
  });
});

describe("scrollIntoView", () => {
  test("centers the element and answers with the viewport", () => {
    let button = document.querySelector("button")!;
    let spy = vi.spyOn(button, "scrollIntoView");
    let result = scrollIntoView(refFor(button));
    expect(spy).toHaveBeenCalledWith({
      block: "center",
      inline: "center",
      behavior: "instant",
    });
    expect(result.ok).toBe(true);
  });

  test("unknown ref fails", () => {
    expect(scrollIntoView(99999)).toEqual({
      ok: false,
      error: "ref 99999 is unknown",
    });
  });
});
