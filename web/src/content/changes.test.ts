// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { answerEvent, pendingEvent } from "../main/network";
import {
  maxElements,
  quietMs,
  startDiff,
  takeDiff,
  unchangedMs,
} from "./changes";
import { installNetworkReader } from "./network";

let refless = (lines: string[]) =>
  lines.map((line) => line.replace(/ \[ref=[\d:]+\]/g, ""));

// Starts a diff over html, changes the page, and answers what the diff saw, without waiting for quiet.
async function diffAfter(html: string, change: () => void, maxChars = 2000) {
  document.body.innerHTML = html;
  startDiff();
  change();
  return await takeDiff("", 0, maxChars);
}

let pending = 0;

installNetworkReader();

// happy-dom has no Web Animations; each root answers what animations holds for it.
let animations = new Map<Document | ShadowRoot, Animation[]>();

for (let prototype of [
  Object.getPrototypeOf(document),
  Object.getPrototypeOf(
    document.createElement("div").attachShadow({ mode: "open" }),
  ),
])
  Object.defineProperty(prototype, "getAnimations", {
    configurable: true,
    value(this: Document | ShadowRoot) {
      return animations.get(this) ?? [];
    },
  });

beforeEach(() => {
  document.body.innerHTML = "";
  pending = 0;
  animations.clear();
  vi.restoreAllMocks();
});

describe("diff lines", () => {
  test("nothing different is no lines", async () => {
    let result = await diffAfter("<main><button>Go</button></main>", () => {});
    expect(result).toMatchObject({
      ok: true,
      started: true,
      tooLarge: false,
      lines: [],
      added: 0,
      changed: 0,
      removed: 0,
      omitted: 0,
    });
  });

  test("an added element shows whole with refs under its surviving parent", async () => {
    let result = await diffAfter("<main><button>Menu</button></main>", () =>
      document
        .querySelector("main")!
        .insertAdjacentHTML(
          "beforeend",
          '<div role="dialog" aria-label="Sign in"><input aria-label="Email"><button>Continue</button></div>',
        ),
    );
    expect(refless(result.lines)).toEqual([
      "in main:",
      '+ dialog "Sign in"',
      '+   textbox "Email"',
      '+   button "Continue"',
    ]);
    expect(result.lines[0]).toMatch(/^in main \[ref=\d+\]:$/);
    expect(result.lines[1]).toMatch(/^\+ dialog "Sign in" \[ref=\d+\]$/);
    expect(result.added).toBe(3);
  });

  test("a changed element says what it was", async () => {
    let result = await diffAfter(
      '<nav><button aria-expanded="false">Menu</button><input type="checkbox" aria-label="Agree"><input aria-label="Name" value="a"></nav>',
      () => {
        document.querySelector("button")!.setAttribute("aria-expanded", "true");
        document.querySelector<HTMLInputElement>("[type=checkbox]")!.checked =
          true;
        document.querySelector<HTMLInputElement>("[aria-label=Name]")!.value =
          "ab";
      },
    );
    expect(refless(result.lines)).toEqual([
      "in navigation:",
      '~ button "Menu" expanded (was collapsed)',
      '~ checkbox "Agree" checked (was not checked)',
      '~ textbox "Name" value="ab" (was value="a")',
    ]);
    expect(result.changed).toBe(3);
  });

  test("a renamed element and one that lost a state say so", async () => {
    let result = await diffAfter(
      '<button aria-pressed="true">Count 3</button>',
      () => {
        let button = document.querySelector("button")!;
        button.textContent = "Count 4";
        button.removeAttribute("aria-pressed");
      },
    );
    expect(refless(result.lines)).toEqual([
      '~ button "Count 4" (was "Count 3", pressed)',
    ]);
  });

  test("a long old name or text is cut in what it was", async () => {
    let long = "word ".repeat(40).trim();
    let result = await diffAfter(
      `<button>${long}</button><main>${long} <b role="note">x</b></main>`,
      () => {
        document.querySelector("button")!.textContent = "Short";
        document.querySelector("main")!.firstChild!.textContent = "Now ";
      },
    );
    let was = result.lines.map((line) => line.match(/\(was (".*")\)$/)?.[1]);
    expect(was[0]).toHaveLength(82);
    expect(was[0]!.endsWith('..."')).toBe(true);
    expect(was[2]).toBe(was[0]);
  });

  test("only the topmost removed element is listed, without a ref", async () => {
    let result = await diffAfter(
      '<main><div role="alert"><p>Saved</p><button>Undo</button></div><p>Kept</p></main>',
      () => document.querySelector("[role=alert]")!.remove(),
    );
    expect(result.lines).toEqual([
      expect.stringMatching(/^in main \[ref=\d+\]:$/),
      "- alert",
    ]);
    expect(result.removed).toBe(1);
  });

  test("a list rendered again with equal elements shows only what differs", async () => {
    let result = await diffAfter(
      '<main><ul><li><a href="/u/a">A</a></li><li><a href="/u/b" aria-label="B\'s profile"></a></li></ul></main>',
      () =>
        (document.querySelector("ul")!.innerHTML =
          '<li><a href="/u/a">A</a></li><li><a href="/u/b" aria-label="B\'s profile"><img alt="B avatar"></a></li><li>C</li>'),
    );
    expect(refless(result.lines)).toEqual([
      'in link "B\'s profile":',
      '+ img "B avatar"',
      "in list:",
      '+ listitem "C"',
    ]);
  });

  test("changed text runs are paired, others added or removed", async () => {
    let result = await diffAfter(
      "<main>Total: 3 <button>Go</button></main><nav>one <button>x</button></nav>",
      () => {
        document.querySelector("main")!.firstChild!.textContent = "Total: 4 ";
        document.querySelector("nav")!.insertAdjacentHTML("beforeend", " two");
      },
    );
    expect(refless(result.lines)).toEqual([
      "in main:",
      '~ "Total: 4" (was "Total: 3")',
      "in navigation:",
      '+ "two"',
    ]);
  });

  test("changes at the top level have no context line first, and get one back after another", async () => {
    let result = await diffAfter("<main><p>a</p></main><p>b</p>", () => {
      document
        .querySelector("main")!
        .insertAdjacentHTML("beforeend", "<p>c</p>");
      document.body.insertAdjacentHTML("afterbegin", "<p>d</p>");
      document.body.insertAdjacentHTML("beforeend", "<p>e</p>");
    });
    expect(refless(result.lines)).toEqual([
      '+ paragraph "d"',
      "in main:",
      '+ paragraph "c"',
      "in page:",
      '+ paragraph "e"',
    ]);
  });

  test("a frame's refs carry its prefix and its top level is named", async () => {
    document.body.innerHTML = "<p>a</p>";
    startDiff();
    document.body.insertAdjacentHTML("beforeend", "<button>New</button>");
    let result = await takeDiff("5:", 0, 2000);
    expect(result.lines).toEqual([
      "in iframe 5:",
      expect.stringMatching(/^\+ button "New" \[ref=5:\d+\]$/),
    ]);
  });

  test("lines past maxChars are cut on a line boundary and counted", async () => {
    let result = await diffAfter(
      "<main><h1>List</h1></main>",
      () =>
        document
          .querySelector("main")!
          .insertAdjacentHTML(
            "beforeend",
            Array.from(
              { length: 30 },
              (_, index) => `<button>Item ${index}</button>`,
            ).join(""),
          ),
      200,
    );
    expect(result.lines.join("\n").length).toBeLessThanOrEqual(200);
    expect(result.lines.at(-1)).toMatch(/^\+ button "Item \d+" \[ref=\d+\]$/);
    expect(result.added).toBe(30);
    expect(result.omitted).toBe(30 - (result.lines.length - 1));
  });

  test("a secret field's value never shows, before or after", async () => {
    document.body.innerHTML =
      '<input type="password" aria-label="Password"><input type="password" aria-label="PIN" value="1234">';
    startDiff();
    document.querySelector<HTMLInputElement>("[aria-label=Password]")!.value =
      "hunter2";
    document.querySelector<HTMLInputElement>("[aria-label=PIN]")!.value =
      "5678";
    let result = await takeDiff("", 0, 2000);
    expect(refless(result.lines)).toEqual([
      '~ textbox "Password" value=[hidden] (was no value)',
      '~ textbox "PIN" value=[hidden] (was value=[hidden])',
    ]);
    expect(result.lines.join("\n")).not.toMatch(/hunter2|1234|5678/);
  });

  test("a value changed past where its value= state is cut is still a change", async () => {
    let start = "const array = [5, 12, 8, 130, 44]; let index = 2;";
    let result = await diffAfter(
      `<textarea aria-label="Code">${start}</textarea>`,
      () =>
        (document.querySelector("textarea")!.value = start.replace("2;", "4;")),
    );
    expect(result.changed).toBe(1);
    expect(refless(result.lines)[0]).toMatch(
      /^~ textbox "Code" value="const array .*" \(was value="const array .*"\)$/,
    );
  });

  test("a page with more than maxElements elements is too large to diff", async () => {
    document.body.innerHTML = "<i></i>".repeat(maxElements + 1);
    expect(startDiff()).toEqual({ ok: true, tooLarge: true });
    let result = await takeDiff("", 2000, 2000);
    expect(result).toMatchObject({ started: true, tooLarge: true, lines: [] });
  }, 30000);

  test("a document that saw no diffStart says so", async () => {
    await takeDiff("", 0, 2000);
    expect(await takeDiff("", 0, 2000)).toMatchObject({
      started: false,
      lines: [],
    });
  });
});

describe("waiting for quiet", () => {
  test("waits for a mutation that comes after the action", async () => {
    document.body.innerHTML = "<main><h1>Results</h1></main>";
    startDiff();
    setTimeout(
      () =>
        document
          .querySelector("main")!
          .insertAdjacentHTML("beforeend", "<p>Later</p>"),
      quietMs / 2,
    );
    let begun = Date.now();
    let result = await takeDiff("", 2000, 2000);
    expect(Date.now() - begun).toBeGreaterThanOrEqual(quietMs);
    expect(refless(result.lines)).toEqual(["in main:", '+ paragraph "Later"']);
    expect(result.settled).toBe(true);
  });

  test("a change that comes after the page went quiet is still seen", async () => {
    document.body.innerHTML = "<main><button>Run</button></main>";
    startDiff();
    setTimeout(
      () =>
        document
          .querySelector("main")!
          .insertAdjacentHTML("beforeend", "<ul><li>44</li></ul>"),
      quietMs * 4,
    );
    let result = await takeDiff("", 2000, 2000);
    expect(refless(result.lines)).toEqual([
      "in main:",
      "+ list",
      '+   listitem "44"',
    ]);
  });

  test("an unchanged page answers once the unchanged watch ends, before the wait does", async () => {
    document.body.innerHTML = "<main><button>Run</button></main>";
    let begun = Date.now();
    startDiff();
    let result = await takeDiff("", 2000, 2000);
    let took = Date.now() - begun;
    expect(result.lines).toEqual([]);
    expect(took).toBeGreaterThanOrEqual(unchangedMs - 20);
    expect(took).toBeLessThan(2000);
  });

  test("sees mutations inside open shadow roots", async () => {
    document.body.innerHTML = "<div id=host></div>";
    let shadow = document
      .querySelector("#host")!
      .attachShadow({ mode: "open" });
    shadow.innerHTML = "<p>a</p>";
    startDiff();
    let begun = Date.now();
    setTimeout(() => (shadow.querySelector("p")!.textContent = "b"), 60);
    setTimeout(() => (shadow.querySelector("p")!.textContent = "c"), 120);
    let result = await takeDiff("", 2000, 2000);
    expect(Date.now() - begun).toBeGreaterThanOrEqual(120 + quietMs);
    expect(refless(result.lines)).toEqual(['~ paragraph "c" (was "a")']);
  });

  test("on a hidden page, finite animations the action starts are finished, others left alone", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    let animation = (endTime: number) =>
      ({
        playState: "running",
        effect: { getComputedTiming: () => ({ endTime }) },
        finish: vi.fn(),
      }) as unknown as Animation;
    document.body.innerHTML = "<div id=host></div>";
    let shadow = document
      .querySelector("#host")!
      .attachShadow({ mode: "open" });
    let before = animation(250);
    animations.set(document, [before]);
    startDiff();
    let exit = animation(250);
    let spinner = animation(Infinity);
    animations.set(shadow, [exit, spinner]);
    await takeDiff("", 0, 2000);
    expect(exit.finish).toHaveBeenCalledOnce();
    expect(before.finish).not.toHaveBeenCalled();
    expect(spinner.finish).not.toHaveBeenCalled();
  });

  test("inline style changes alone do not restart the quiet clock", async () => {
    document.body.innerHTML = "<main><p id=bar>Loading</p></main>";
    let bar = document.querySelector("#bar")!;
    startDiff();
    let ticking = setInterval(
      () => bar.setAttribute("style", `width: ${Date.now() % 100}px`),
      20,
    );
    let begun = Date.now();
    let result = await takeDiff("", 2000, 2000);
    clearInterval(ticking);
    expect(Date.now() - begun).toBeLessThan(unchangedMs + quietMs);
    expect(result.settled).toBe(true);
    expect(result.lines).toEqual([]);
  });

  test("waits for fetch and XHR calls the main-world capture counts", async () => {
    let asked: number[] = [];
    let answer = (event: Event) => {
      asked.push(JSON.parse((event as CustomEvent).detail).since);
      window.dispatchEvent(
        new CustomEvent(answerEvent, { detail: String(pending) }),
      );
    };
    window.addEventListener(pendingEvent, answer);

    try {
      document.body.innerHTML = "<main><h1>Results</h1></main>";
      let begun = Date.now();
      startDiff();
      pending = 1;
      setTimeout(() => {
        pending = 0;
        document
          .querySelector("main")!
          .insertAdjacentHTML("beforeend", "<p>Loaded</p>");
      }, 300);
      let result = await takeDiff("", 2000, 2000);
      expect(Date.now() - begun).toBeGreaterThanOrEqual(300 + quietMs);
      expect(asked[0]).toBeGreaterThanOrEqual(begun);
      expect(result).toMatchObject({
        tracked: true,
        pending: 0,
        settled: true,
      });
      expect(refless(result.lines)).toEqual([
        "in main:",
        '+ paragraph "Loaded"',
      ]);
    } finally {
      window.removeEventListener(pendingEvent, answer);
    }
  });

  test("stops at waitMs with what has changed so far and says it was not settled", async () => {
    let answer = () =>
      window.dispatchEvent(new CustomEvent(answerEvent, { detail: "2" }));
    window.addEventListener(pendingEvent, answer);

    try {
      document.body.innerHTML = "<main><h1>Results</h1></main>";
      startDiff();
      let begun = Date.now();
      let result = await takeDiff("", 150, 2000);
      expect(Date.now() - begun).toBeLessThan(1000);
      expect(result).toMatchObject({
        tracked: true,
        pending: 2,
        settled: false,
        lines: [],
      });
    } finally {
      window.removeEventListener(pendingEvent, answer);
    }
  });

  test("without a main-world capture, requests are not tracked and only the DOM is waited for", async () => {
    document.body.innerHTML = "<main><h1>Results</h1></main>";
    startDiff();
    let result = await takeDiff("", 2000, 2000);
    expect(result).toMatchObject({ tracked: false, pending: 0, settled: true });
  });
});
