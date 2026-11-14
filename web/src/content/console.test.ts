// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  callerOf,
  formatArgs,
  formatValue,
  installCapture,
  maxEntries,
  maxText,
  takeEvent,
} from "../main/console";
import { installReader, takeConsole } from "./console";

let originals = {
  log: vi.fn(() => "log returned"),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
let installed = false;
let take = (onlyErrors = false, pattern: string | null = null, limit = 200) =>
  takeConsole(onlyErrors, pattern, limit, false);
let tick = () => new Promise((resolve) => setTimeout(resolve, 5));

installReader();

describe("without the main-world script", () => {
  test("a frame reports no capture", () => {
    expect(take()).toEqual({
      ok: true,
      capturing: false,
      entries: [],
      matched: 0,
      dropped: 0,
    });
  });
});

describe("console capture", () => {
  beforeEach(() => {
    if (!installed) {
      Object.assign(window.console, originals);
      installCapture(window as unknown as Window & typeof globalThis);
      installed = true;
    }

    takeConsole(false, null, 1, true);
    Object.values(originals).forEach((original) => original.mockClear());
  });

  test("records every level and keeps the original call and its return value", () => {
    expect(window.console.log("hello", 2)).toBe("log returned");
    window.console.info("info");
    window.console.warn("warn");
    window.console.error("error");
    window.console.debug("debug");
    expect(originals.log).toHaveBeenCalledWith("hello", 2);
    expect(originals.debug).toHaveBeenCalledWith("debug");
    expect(window.console.log.name).toBe("log");
    let { entries } = take();
    expect(entries.map((entry) => [entry.level, entry.text])).toEqual([
      ["log", "hello 2"],
      ["info", "info"],
      ["warn", "warn"],
      ["error", "error"],
      ["debug", "debug"],
    ]);
    expect(entries[0].url).toBe(location.href);
    expect(entries[0].source).toMatch(/console\.test\.ts:\d+:\d+$/);
    expect(entries[0].time).toBeGreaterThan(Date.now() - 5000);
  });

  test("a getter that logs while being formatted is passed through, not recorded again", () => {
    let chatty = {
      get value() {
        window.console.log("from the getter");
        return 1;
      },
    };
    window.console.log(chatty);
    expect(originals.log).toHaveBeenCalledWith("from the getter");
    expect(take().entries.map((entry) => entry.text)).toEqual(["{value: 1}"]);
  });

  test("a throwing argument neither breaks the page's call nor the capture", () => {
    let hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("no keys");
        },
      },
    );
    window.console.log("value", hostile);
    expect(originals.log).toHaveBeenCalledWith("value", hostile);
    expect(take().entries[0].text).toBe("value [unreadable]");
  });

  test("filters by errors, pattern and limit, newest last, and clears on request", () => {
    window.console.log("first apple");
    window.console.error("second Apple");
    window.console.warn("third pear");
    window.console.error("fourth apple");
    expect(take(true).entries.map((entry) => entry.text)).toEqual([
      "second Apple",
      "fourth apple",
    ]);
    expect(take(false, "APPLE").matched).toBe(3);
    expect(take(false, "apple", 2)).toMatchObject({
      matched: 3,
      entries: [{ text: "second Apple" }, { text: "fourth apple" }],
    });
    expect(takeConsole(false, "pear", 5, true).entries.length).toBe(1);
    expect(take().entries).toEqual([]);
  });

  test("keeps the newest entries and counts the dropped ones until cleared", () => {
    for (let index = 0; index < maxEntries + 5; index++)
      window.console.log(`line ${index}`);

    let result = take(false, null, 200);
    expect(result).toMatchObject({ matched: maxEntries, dropped: 5 });
    expect(result.entries.at(-1)!.text).toBe(`line ${maxEntries + 4}`);
    expect(takeConsole(false, null, 1, true).dropped).toBe(5);
    expect(take().dropped).toBe(0);
  });

  test("records uncaught errors and rejections the page did not cancel", async () => {
    let thrown = new Error("boom");
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: thrown,
        message: "Uncaught Error: boom",
        filename: "https://example.com/app.js",
        lineno: 3,
        colno: 9,
      }),
    );
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    window.addEventListener("error", (event) => event.preventDefault(), {
      once: true,
    });
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("quiet"), cancelable: true }),
    );
    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason: "nope" }),
    );
    window.dispatchEvent(new Event("error"));
    await tick();
    let entries = take(true).entries;
    expect(entries.map((entry) => entry.level)).toEqual([
      "exception",
      "exception",
      "exception",
    ]);
    expect(entries[0].text).toMatch(/^Uncaught Error: boom\n/);
    expect(entries[0].source).toBe("https://example.com/app.js:3:9");
    expect(entries[1]).toMatchObject({
      text: "Uncaught Script error.",
      source: null,
    });
    expect(entries[2].text).toBe("Unhandled Promise Rejection: nope");
  });

  test("only the capture's own answer counts, not one a page dispatches later", () => {
    window.addEventListener(
      takeEvent,
      () =>
        window.dispatchEvent(
          new CustomEvent("safaripilot-console-entries", {
            detail: JSON.stringify({ entries: [{ text: "forged" }] }),
          }),
        ),
      { once: true },
    );
    window.console.log("real");
    expect(take().entries.map((entry) => entry.text)).toEqual(["real"]);
  });
});

describe("formatting", () => {
  test("applies format specifiers and joins the rest", () => {
    expect(
      formatArgs(["%s is %d years, %f%%", "Ada", 36.7, 1.5, "extra"]),
    ).toBe("Ada is 36 years, 1.5% extra");
    expect(formatArgs(["%cstyled", "color: red"])).toBe("styled");
    expect(formatArgs(["50% off"])).toBe("50% off");
    expect(formatArgs(["%o", { a: 1 }])).toBe("{a: 1}");
  });

  test("shows objects, cycles, nodes and errors without throwing", () => {
    let cycle: Record<string, unknown> = { name: "loop" };
    cycle.self = cycle;
    expect(formatValue(cycle, 0, new Set())).toBe(
      '{name: "loop", self: [circular]}',
    );
    expect(
      formatValue({ deep: { deeper: { deepest: 1 } } }, 0, new Set()),
    ).toBe("{deep: {deeper: [Object]}}");
    expect(formatValue([1, "two", null, undefined, 3n], 0, new Set())).toBe(
      '[1, "two", null, undefined, 3n]',
    );
    expect(
      formatValue(
        Array.from({ length: 25 }, () => 0),
        0,
        new Set(),
      ),
    ).toMatch(/, \.\.\. 5 more\]$/);
    expect(formatValue(new Map([["key", 1]]), 0, new Set())).toBe(
      'Map(1) {"key" => 1}',
    );
    expect(formatValue(new Set([1]), 0, new Set())).toBe("Set(1) {1}");
    let element = document.createElement("div");
    element.id = "main";
    element.className = "card wide";
    expect(formatValue(element, 0, new Set())).toBe("<div#main.card.wide>");
    expect(formatValue(document.createTextNode("x"), 0, new Set())).toBe(
      "#text",
    );
    expect(formatValue(function named() {}, 0, new Set())).toBe(
      "[function named]",
    );
    expect(formatValue({ error: new TypeError("bad") }, 0, new Set())).toBe(
      "{error: TypeError: bad}",
    );
    expect(formatValue(Symbol("tag"), 0, new Set())).toBe("Symbol(tag)");
  });

  test("caps the text", () => {
    let text = formatArgs(["x".repeat(maxText + 10)]);
    expect(text).toBe(`${"x".repeat(maxText)}... (10 more characters)`);
  });

  test("finds the caller in JSC and V8 stacks, skipping the capture's own lines", () => {
    let own = "webkit-masked-url://hidden/";
    let jsc = `log@${own}:1:200\nshow@https://example.com/app.js:12:5\nglobal code@https://example.com/app.js:20:1`;
    expect(callerOf(jsc, own)).toBe("https://example.com/app.js:12:5");
    let v8 =
      "Error\n    at Object.log (file:///x/main.js:3:4)\n    at run (https://example.com/a.js:7:2)";
    expect(callerOf(v8, "file:///x/main.js")).toBe(
      "https://example.com/a.js:7:2",
    );
    expect(callerOf("[native code]", null)).toBeNull();
  });
});
