// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { find } from "./find";
import { resolveRef } from "./refs";

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: { scale: 1, offsetLeft: 0, offsetTop: 0, width: 1000, height: 800 },
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      let width = (this as HTMLElement).dataset.empty ? 0 : 100;
      return new DOMRect(10, 10, width, 20);
    },
  );
});

let names = (name: string, role = "") => {
  let result = find(name, role);
  return result.ok ? result.matches.map((match) => match.name) : result.error;
};

describe("find", () => {
  test("matches accessible names case-insensitively, not text inside plain containers", () => {
    document.body.innerHTML =
      '<button>Save Draft</button><p>Draft saved at noon</p><input placeholder="Draft title"><span>Other</span>';
    expect(names("DRAFT")).toEqual(["Save Draft", "Draft title"]);
  });

  test("a field inside a matching landmark is returned", () => {
    document.body.innerHTML =
      '<form role="search" aria-label="Search the web"><input type="search" aria-label="Search Wikipedia"></form>';
    expect(names("search")).toEqual(["Search the web", "Search Wikipedia"]);
  });

  test("role filters exactly and works without a name", () => {
    document.body.innerHTML =
      '<div role="search"><input type="search" aria-label="Query"></div><a href="#">Search help</a><textarea role="combobox" aria-label="Ask"></textarea>';
    expect(names("", "searchbox")).toEqual(["Query"]);
    expect(names("search", "link")).toEqual(["Search help"]);
    expect(names("", "COMBOBOX")).toEqual(["Ask"]);
    expect(names("search", "button")).toEqual([]);
  });

  test("role text alone does not match a name", () => {
    document.body.innerHTML = "<button>Go</button>";
    expect(names("button")).toEqual([]);
  });

  test("named matches get refs that resolve", () => {
    document.body.innerHTML = "<h2>Shipping costs</h2>";
    let result = find("shipping", "");
    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(resolveRef(result.matches[0].ref)).toBe(
      document.querySelector("h2"),
    );
  });

  test("skips boxless, hidden and aria-hidden elements", () => {
    document.body.innerHTML =
      '<button data-empty="1">Go</button><button hidden>Go</button><div aria-hidden="true"><button>Go</button></div><button>Go</button>';
    expect(names("go")).toEqual(["Go"]);
  });

  test("finds a visible element inside a visibility:hidden one, but not the hidden one", () => {
    document.body.innerHTML =
      '<div role="menu" style="visibility: hidden"><button>Go</button><button style="visibility: visible">Go</button></div>';
    expect(names("go")).toEqual(["Go"]);
    expect(names("", "menu")).toEqual([]);
  });

  test("caps results at 20", () => {
    document.body.innerHTML = "<button>x</button>".repeat(30);
    expect(names("", "button")).toHaveLength(20);
  });

  test("needs a name or a role", () => {
    expect(names("  ")).toBe("find needs a name or a role");
  });

  test("a clickable generic wrapping widgets is not named by them", () => {
    document.body.innerHTML =
      '<div onclick="1"><a href="#in">Zoom In</a><a href="#out">Zoom Out</a></div>';
    expect(names("zoom")).toEqual(["Zoom In", "Zoom Out"]);
  });

  test("a widget around one widget of the same name is listed once, unless only it has the role", () => {
    document.body.innerHTML =
      '<div role="grid"><div role="row"><div role="gridcell"><div role="button" tabindex="0">usb c cable</div></div></div></div>';
    let roles = (role: string) => {
      let result = find("usb", role);
      return result.ok ? result.matches.map((match) => match.role) : [];
    };
    expect(roles("")).toEqual(["button"]);
    expect(roles("gridcell")).toEqual(["gridcell"]);
  });
});
