// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { describe as describeTarget, nameOf, roleOf } from "./describe";

let first = (html: string) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("roleOf", () => {
  test.each([
    ['<a href="#x">x</a>', "link"],
    ["<a>x</a>", "generic"],
    ["<button>x</button>", "button"],
    ['<input type="checkbox">', "checkbox"],
    ['<input type="radio">', "radio"],
    ['<input type="email">', "textbox"],
    ['<input type="search">', "searchbox"],
    ['<input type="submit">', "button"],
    ["<textarea></textarea>", "textbox"],
    ["<select><option>a</option></select>", "combobox"],
    ["<select multiple><option>a</option></select>", "listbox"],
    ["<summary>x</summary>", "button"],
    ['<div role="menuitem tab">x</div>', "menuitem"],
    ["<div>x</div>", "generic"],
  ])("%s is %s", (html, role) => {
    expect(roleOf(first(html))).toBe(role);
  });
});

describe("nameOf", () => {
  test("aria-labelledby beats aria-label and text", () => {
    document.body.innerHTML =
      '<span id="one">Hello</span><span id="two">there</span><button aria-labelledby="one two" aria-label="no">text</button>';
    expect(nameOf(document.querySelector("button")!)).toBe("Hello there");
  });

  test("aria-label beats text", () => {
    expect(nameOf(first('<button aria-label="Close">x</button>'))).toBe(
      "Close",
    );
  });

  test("label element names an input", () => {
    document.body.innerHTML =
      '<label for="field">Email  address</label><input id="field" placeholder="you@x">';
    expect(nameOf(document.querySelector("input")!)).toBe("Email address");
  });

  test("text inputs never use their value, placeholder is last", () => {
    expect(nameOf(first('<input value="secret" placeholder="Search">'))).toBe(
      "Search",
    );
  });

  test("button inputs use value", () => {
    expect(nameOf(first('<input type="submit" value="Send">'))).toBe("Send");
  });

  test("text content is collapsed and truncated", () => {
    let name = nameOf(first(`<a href="#">  ${"word ".repeat(40)} </a>`));
    expect(name.length).toBe(80);
    expect(name.endsWith("...")).toBe(true);
  });

  test("image alt when there is no text", () => {
    expect(nameOf(first('<a href="#"><img alt="Logo"></a>'))).toBe("Logo");
  });

  test("images with empty alt give way to later ones", () => {
    expect(
      nameOf(
        first(
          '<a href="#"><img alt=""><span><img alt="Wiki"><img alt="Free"></span></a>',
        ),
      ),
    ).toBe("Wiki Free");
  });

  test("hidden content and nested labels", () => {
    expect(
      nameOf(
        first(
          '<button><span aria-hidden="true">x</span><span hidden>no</span><svg aria-label="Close"></svg> dialog</button>',
        ),
      ),
    ).toBe("Close dialog");
  });

  test("svg title names an svg and the link around it", () => {
    let link = first(
      '<a href="/"><svg role="img"><title>MDN</title></svg></a>',
    );
    expect(nameOf(link)).toBe("MDN");
    expect(nameOf(link.firstElementChild!)).toBe("MDN");
  });

  test("block children are separated, inline ones are not", () => {
    expect(
      nameOf(
        first(
          '<a href="#"><span>LIVE</span><div>Headline</div><p>Summary</p>end<b>s</b></a>',
        ),
      ),
    ).toBe("LIVE Headline Summary ends");
  });

  test("a br separates words", () => {
    expect(nameOf(first("<button>Stat<sup>[1]</sup><br>2026</button>"))).toBe(
      "Stat[1] 2026",
    );
  });

  test("labels skip hidden text, other fields and repeats", () => {
    document.body.innerHTML =
      '<label for="a">Once<span style="display: none">Once</span></label><label>Once <input id="a" type="radio"><select><option>S</option></select></label>';
    expect(nameOf(document.querySelector("input")!)).toBe("Once");
  });

  test("shadow content counts", () => {
    let host = first("<button></button>");
    host.attachShadow({ mode: "open" }).innerHTML = "<span>Shadow</span>";
    expect(nameOf(host)).toBe("Shadow");
  });
});

describe("describe", () => {
  test("tag, id, first class and text", () => {
    expect(
      describeTarget(first('<button id="go" class="big red">Go now</button>')),
    ).toBe('button#go.big "Go now"');
    expect(describeTarget(window)).toBe("window");
    expect(describeTarget(document)).toBe("document");
  });
});
