// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { find, target } from "./find";
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
      let top = Number((this as HTMLElement).dataset.top ?? 10);
      return new DOMRect(10, top, width, 20);
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

  test("a radio hidden at no size behind its label is found with the label's box", () => {
    document.body.innerHTML =
      '<input type="radio" id="double" name="scale" data-empty="1"><label for="double" data-top="40">2x</label>';
    let result = find("2x", "radio");
    expect(result.ok && result.matches).toEqual([
      expect.objectContaining({
        role: "radio",
        name: "2x",
        rect: { left: 10, top: 40, width: 100, height: 20 },
      }),
    ]);
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

  test("on-screen matches fill the cap before offscreen ones above them", () => {
    document.body.innerHTML =
      '<button data-top="-5000">above</button>'.repeat(25) +
      "<button>here</button>".repeat(3) +
      '<button data-top="5000">below</button>';
    let result = names("", "button");
    expect(result).toHaveLength(20);
    expect(result.slice(0, 4)).toEqual(["here", "here", "here", "above"]);
    expect(result).not.toContain("below");
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

test("find never returns a field's value, secret or not", () => {
  document.body.innerHTML =
    '<input autocomplete="one-time-code" value="482913"><textarea>draft text</textarea><div contenteditable="true" aria-label="Password">hunter2</div>';
  let result = JSON.stringify(find("", "textbox"));
  expect(result).toContain('"role":"textbox"');

  for (let value of ["482913", "draft text", "hunter2"])
    expect(result).not.toContain(value);
});

describe("target", () => {
  let picked = (name: string, role = "") => {
    let result = target(name, role);

    if (!result.ok) return result.error;

    let { matched, exact } = result;
    let matches = result.matches.map((match) =>
      [match.name, match.exact, match.inViewport].join(" "),
    );
    return { matched, exact, matches };
  };

  test("counts every rendered match, offscreen ones too, with exact names first", () => {
    document.body.innerHTML =
      '<button>Sign in with Google</button><button data-top="5000">  SIGN IN </button><a href="#">Sign in help</a><button data-empty="1">Sign in</button>';
    expect(picked("sign in")).toEqual({
      matched: 3,
      exact: 1,
      matches: [
        "SIGN IN true false",
        "Sign in with Google false true",
        "Sign in help false true",
      ],
    });
  });

  test("an exact name ignores case and surrounding whitespace but not inner text", () => {
    document.body.innerHTML =
      '<button aria-label=" Save ">x</button><button>Save draft</button>';
    expect(picked("  SAVE ")).toMatchObject({ matched: 2, exact: 1 });
    expect(picked("save dr")).toMatchObject({ matched: 1, exact: 0 });
  });

  test("a role alone has no exact matches, so an unnamed element never wins", () => {
    document.body.innerHTML =
      '<button aria-label=""></button><button>Go</button>';
    expect(picked("", "button")).toMatchObject({ matched: 2, exact: 0 });
    expect(picked("go", "button")).toMatchObject({ matched: 1, exact: 1 });
    expect(picked("go", "link")).toMatchObject({ matched: 0, exact: 0 });
  });

  test("keeps 20 matches but counts them all, exact ones never cut", () => {
    document.body.innerHTML =
      "<button>Open item</button>".repeat(30) + "<button>Open</button>";
    let result = picked("open", "button") as { matches: string[] };
    expect(result).toMatchObject({ matched: 31, exact: 1 });
    expect(result.matches).toHaveLength(20);
    expect(result.matches[0]).toBe("Open true true");
  });

  test("a widget around one widget of the same name counts once", () => {
    document.body.innerHTML =
      '<div role="option"><a href="#a">Dune</a></div><div role="option" aria-label="Dune">x</div>';
    expect(picked("dune")).toMatchObject({ matched: 2, exact: 2 });
    expect(picked("dune", "link")).toMatchObject({ matched: 1, exact: 1 });
  });

  test("its matches get refs that resolve", () => {
    document.body.innerHTML = "<p>x</p><button>Pay now</button>";
    let result = target("pay now", "");
    expect(result.ok && resolveRef(result.matches[0].ref)).toBe(
      document.querySelector("button"),
    );
  });

  test("needs a name or a role", () => {
    expect(picked(" ", "")).toBe("target needs a name or a role");
  });
});

describe("text fallback", () => {
  test("with no named match and no role, the deepest elements showing the text match", () => {
    document.body.innerHTML =
      '<div id="list"><div class="item">Item 1</div><div class="item">Item 2</div><div class="item">Item <b>10</b></div></div>';
    expect(names("item 1")).toEqual(["Item 1", "Item 10"]);
    let result = find("Item 2", "");
    expect(result.ok && resolveRef(result.matches[0]!.ref)).toBe(
      document.querySelectorAll(".item")[1],
    );
  });

  test("a named match or a role keeps plain text out", () => {
    document.body.innerHTML = "<button>Item 1</button><div>Item 1 notes</div>";
    expect(names("item 1")).toEqual(["Item 1"]);
    document.body.innerHTML = "<div>Item 1</div>";
    expect(names("item 1", "button")).toEqual([]);
  });

  test("never matches a field's value", () => {
    document.body.innerHTML =
      '<textarea>draft text</textarea><input value="draft text">';
    expect(names("draft text")).toEqual([]);
  });
});
