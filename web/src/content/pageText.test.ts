// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import type { PageTextResult } from "../shared/protocol";
import { clip, pageText, textRoot } from "./pageText";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("textRoot", () => {
  test("main beats article beats body", () => {
    document.body.innerHTML =
      "<nav>Menu</nav><article>Story</article><main>Main</main>";
    expect(textRoot().localName).toBe("main");
    document.querySelector("main")!.remove();
    expect(textRoot().localName).toBe("article");
  });

  test("several articles read as the body", () => {
    document.body.innerHTML = "<article>One</article><article>Two</article>";
    expect(textRoot()).toBe(document.body);
  });

  test("hidden main is ignored", () => {
    document.body.innerHTML =
      '<main style="display: none">Old</main><p>Body</p>';
    expect(textRoot()).toBe(document.body);
  });
});

describe("clip", () => {
  test("cuts at the last line break before maxChars", () => {
    expect(clip("first line\nsecond line", 15)).toEqual({
      text: "first line",
      truncated: true,
    });
    expect(clip("one long line", 4)).toEqual({ text: "one ", truncated: true });
    expect(clip("short", 10)).toEqual({ text: "short", truncated: false });
  });
});

describe("pageText", () => {
  test("reads the main content", () => {
    document.body.innerHTML = "<nav>Menu</nav><main><p>Hello</p></main>";
    let result = pageText(1000, "text", null) as PageTextResult;
    expect(result.text).toContain("Hello");
    expect(result.text).not.toContain("Menu");
    expect(result.truncated).toBe(false);
  });
});
