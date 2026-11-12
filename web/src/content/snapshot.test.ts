// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { isInteractive, snapshot } from "./snapshot";

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: { scale: 1, offsetLeft: 0, offsetTop: 0, width: 1000, height: 800 },
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      let top = Number((this as HTMLElement).dataset.top ?? 10);
      return new DOMRect(10, top, 100, 20);
    },
  );
});

describe("isInteractive", () => {
  test.each([
    ['<a href="#">x</a>', true],
    ["<a>x</a>", false],
    ['<input type="hidden">', false],
    ["<input>", true],
    ['<div role="tab">x</div>', true],
    ['<div tabindex="0">x</div>', true],
    ['<div tabindex="-1">x</div>', false],
    ['<div onclick="1">x</div>', true],
    ['<div contenteditable="true">x</div>', true],
    ['<div style="cursor: pointer">x</div>', true],
    ["<div>x</div>", false],
  ])("%s is %s", (html, expected) => {
    document.body.innerHTML = html;
    expect(isInteractive(document.body.firstElementChild!)).toBe(expected);
  });

  test("only the outermost cursor:pointer element counts", () => {
    document.body.innerHTML =
      '<div style="cursor: pointer"><span>x</span></div>';
    expect(isInteractive(document.querySelector("span")!)).toBe(false);
  });
});

describe("snapshot", () => {
  test("walks open shadow roots, flags viewport and keeps refs stable", () => {
    document.body.innerHTML =
      '<button>One</button><a href="#" data-top="2000">Far</a><div id="host"></div>';
    let shadow = document
      .getElementById("host")!
      .attachShadow({ mode: "open" });
    shadow.innerHTML = "<button disabled>Inner</button>";
    let first = snapshot();
    expect(
      first.elements.map((element) => [
        element.name,
        element.role,
        element.inViewport,
        element.disabled ?? false,
      ]),
    ).toEqual([
      ["One", "button", true, false],
      ["Far", "link", false, false],
      ["Inner", "button", true, true],
    ]);
    let second = snapshot();
    expect(second.elements.map((element) => element.ref)).toEqual(
      first.elements.map((element) => element.ref),
    );
  });
});
