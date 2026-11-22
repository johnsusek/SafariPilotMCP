// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import type { ClickAction, Modifier } from "../shared/protocol";
import { syntheticClick } from "./mouse";
import { refFor } from "./refs";

let types = [
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
];
let seen: Event[] = [];
let record = (event: Event) => seen.push(event);

for (let type of types) window.addEventListener(type, record, true);

beforeEach(() => {
  seen = [];
  document.body.innerHTML =
    '<input id="field"><button id="button">Go</button><div id="plain">Plain</div>';
});

let element = (id: string) => document.getElementById(id)!;
let click = (
  id: string,
  action: ClickAction = "left_click",
  modifiers: Modifier[] = [],
) => syntheticClick(refFor(element(id)), action, modifiers);
let summary = () =>
  seen.map((event) => {
    let mouse = event as MouseEvent;
    return `${event.type} ${mouse.button}/${mouse.buttons}/${mouse.detail}`;
  });

describe("syntheticClick", () => {
  test("left click with modifiers fires one press and click", () => {
    let result = click("button", "left_click", ["shift", "cmd"]);
    expect(summary()).toEqual([
      "pointerdown 0/1/0",
      "mousedown 0/1/1",
      "pointerup 0/0/0",
      "mouseup 0/0/1",
      "click 0/0/1",
    ]);
    expect(result).toMatchObject({ ok: true, target: 'button#button "Go"' });

    for (let event of seen) {
      let mouse = event as MouseEvent;
      expect([
        mouse.shiftKey,
        mouse.metaKey,
        mouse.ctrlKey,
        mouse.altKey,
      ]).toEqual([true, true, false, false]);
      expect(event.bubbles && event.composed && event.cancelable).toBe(true);
    }

    expect((seen[0] as PointerEvent).pointerType).toBe("mouse");
    expect((seen[0] as PointerEvent).isPrimary).toBe(true);
  });

  test("double click fires dblclick after the second click", () => {
    click("plain", "double_click");
    expect(seen.map((event) => event.type).slice(5)).toEqual([
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
      "dblclick",
    ]);
    expect(summary().filter((line) => !line.startsWith("pointer"))).toEqual([
      "mousedown 0/1/1",
      "mouseup 0/0/1",
      "click 0/0/1",
      "mousedown 0/1/2",
      "mouseup 0/0/2",
      "click 0/0/2",
      "dblclick 0/0/2",
    ]);
  });

  test("triple click counts to 3 with one dblclick", () => {
    click("plain", "triple_click");
    let clicks = seen.filter((event) => event.type === "click");
    expect(clicks.map((event) => (event as MouseEvent).detail)).toEqual([
      1, 2, 3,
    ]);
    expect(seen.filter((event) => event.type === "dblclick")).toHaveLength(1);
    expect(seen.at(-1)!.type).toBe("click");
  });

  test("right click fires contextmenu after mousedown and auxclick, not click", () => {
    let result = click("plain", "right_click", ["ctrl"]);
    expect(summary()).toEqual([
      "pointerdown 2/2/0",
      "mousedown 2/2/1",
      "contextmenu 2/2/1",
      "pointerup 2/0/0",
      "mouseup 2/0/1",
      "auxclick 2/0/1",
    ]);
    expect((seen[2] as MouseEvent).ctrlKey).toBe(true);
    expect(result).toMatchObject({
      dispatched: expect.arrayContaining([
        { type: "contextmenu", canceled: false },
      ]),
    });
  });

  test("reports events a listener canceled", () => {
    element("plain").addEventListener("contextmenu", (event) =>
      event.preventDefault(),
    );
    let result = click("plain", "right_click");
    expect(result).toMatchObject({
      dispatched: expect.arrayContaining([
        { type: "contextmenu", canceled: true },
      ]),
    });
  });

  test("a canceled pointerdown drops mousedown and mouseup but not click", () => {
    element("plain").addEventListener("pointerdown", (event) =>
      event.preventDefault(),
    );
    click("plain", "left_click", ["alt"]);
    expect(seen.map((event) => event.type)).toEqual([
      "pointerdown",
      "pointerup",
      "click",
    ]);
  });

  test("focuses a text field but not a button, which blurs the focused field", () => {
    click("field", "double_click");
    expect(document.activeElement).toBe(element("field"));
    click("button", "left_click", ["shift"]);
    expect(document.activeElement).toBe(document.body);
  });

  test("a canceled mousedown keeps focus where it was", () => {
    element("field").focus();
    element("plain").setAttribute("tabindex", "0");
    element("plain").addEventListener("mousedown", (event) =>
      event.preventDefault(),
    );
    let result = click("plain", "left_click", ["cmd"]);
    expect(document.activeElement).toBe(element("field"));
    expect(result).toMatchObject({ focused: "input#field" });
  });

  test("focuses the nearest tabindex ancestor of the target", () => {
    document.body.innerHTML =
      '<div id="host" tabindex="-1"><span id="inner">Inner</span></div>';
    click("inner", "double_click");
    expect(document.activeElement).toBe(element("host"));
  });

  test("the pointer moves in before the press, with one enter event per entered element", () => {
    let entered: string[] = [];
    let moves: string[] = [];

    element("button").addEventListener("mouseover", (event) =>
      moves.push(event.type),
    );

    for (let at of [document.documentElement, document.body, element("button")])
      at.addEventListener("mouseenter", (event) => {
        if (event.target === event.currentTarget) entered.push(at.localName);
      });

    let result = click("button");
    expect(entered).toEqual(["html", "body", "button"]);
    expect(moves).toEqual(["mouseover"]);
    expect(result).toMatchObject({
      dispatched: [
        { type: "pointerover" },
        { type: "pointerenter" },
        { type: "mouseover" },
        { type: "mouseenter" },
        { type: "pointermove" },
        { type: "mousemove" },
        { type: "pointerdown" },
        { type: "mousedown" },
        { type: "pointerup" },
        { type: "mouseup" },
        { type: "click" },
      ],
    });
  });

  test("the press goes to an element a mouseenter handler swapped in", () => {
    let clicked = 0;
    let original = element("plain");
    let clone = original.cloneNode(true) as HTMLElement;
    clone.addEventListener("click", () => clicked++);
    original.addEventListener("mouseenter", () => original.replaceWith(clone));
    document.elementFromPoint = () => (original.isConnected ? original : clone);
    let result = click("plain");
    delete (document as Partial<Document>).elementFromPoint;
    expect(clicked).toBe(1);
    expect(result).toMatchObject({ target: 'div#plain "Plain"' });
  });

  test("an unknown ref fails", () => {
    expect(syntheticClick(999999, "left_click", ["shift"])).toMatchObject({
      ok: false,
    });
  });
});
