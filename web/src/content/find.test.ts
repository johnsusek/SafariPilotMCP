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

let names = (query: string) => {
  let result = find(query);
  return result.ok ? result.matches.map((match) => match.name) : result.error;
};

describe("find", () => {
  test("matches name, text and placeholder case-insensitively", () => {
    document.body.innerHTML =
      '<button>Save Draft</button><p>Draft saved at noon</p><input placeholder="Draft title"><span>Other</span>';
    expect(names("DRAFT")).toEqual(["Save Draft", "", "Draft title"]);
  });

  test("non-interactive matches get refs that resolve", () => {
    document.body.innerHTML = "<p>Shipping costs</p>";
    let result = find("shipping");
    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(resolveRef(result.matches[0].ref)).toBe(document.querySelector("p"));
  });

  test("an outer match hides matches inside it", () => {
    document.body.innerHTML = '<a href="#"><span>Docs</span></a>';
    let result = find("docs");
    expect(result.ok && result.matches.map((match) => match.tag)).toEqual([
      "a",
    ]);
  });

  test("skips boxless, hidden and aria-hidden elements", () => {
    document.body.innerHTML =
      '<button data-empty="1">Go</button><button hidden>Go</button><div aria-hidden="true"><button>Go</button></div><button>Go</button>';
    expect(names("go")).toEqual(["Go"]);
  });

  test("matches role and caps results at 20", () => {
    document.body.innerHTML = "<button>x</button>".repeat(30);
    expect(names("button")).toHaveLength(20);
  });

  test("empty query fails", () => {
    expect(names("  ")).toBe("find needs a non-empty query");
  });
});
