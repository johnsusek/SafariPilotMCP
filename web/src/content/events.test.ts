// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { installLogger, record, recordCoalesced, takeEvents } from "./events";
import { inspect } from "./inspect";
import { refFor } from "./refs";

let entry = (index: number) => ({
  type: "click",
  isTrusted: false,
  ref: null,
  target: `t${index}`,
  time: index,
  detail: "",
  count: 1,
});

describe("ring buffer", () => {
  test("keeps the newest 500 and clears on request", () => {
    takeEvents(true, false);
    for (let index = 0; index < 520; index++) record(entry(index));
    let events = takeEvents(false, false);
    expect(events.length).toBe(500);
    expect(events[0].target).toBe("t20");
    expect(events[499].target).toBe("t519");
    expect(takeEvents(true, false).length).toBe(500);
    expect(takeEvents(false, false)).toEqual([]);
  });

  test("coalesces consecutive identical entries", () => {
    takeEvents(true, false);
    recordCoalesced({ ...entry(1), type: "mousemove", detail: "first" });
    recordCoalesced({ ...entry(1), type: "mousemove", detail: "last" });
    recordCoalesced({ ...entry(1), type: "mousemove", isTrusted: true });
    recordCoalesced({ ...entry(2), type: "mousemove" });
    recordCoalesced({ ...entry(1), type: "mousemove" });
    let events = takeEvents(true, false);
    expect(events.map((event) => [event.target, event.count])).toEqual([
      ["t1", 2],
      ["t1", 1],
      ["t2", 1],
      ["t1", 1],
    ]);
    expect(events[0]).toMatchObject({ time: 1, detail: "last" });
  });
});

describe("logger", () => {
  installLogger();

  test("records events with existing refs only", () => {
    takeEvents(true, false);
    document.body.innerHTML =
      '<button id="known">A</button><button id="fresh">B</button>';
    let known = document.getElementById("known")!;
    let fresh = document.getElementById("fresh")!;
    let ref = refFor(known);
    known.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        button: 0,
        clientX: 5,
        clientY: 7,
      }),
    );
    fresh.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "a", code: "KeyA" }),
    );
    let [click, keydown] = takeEvents(true, false);
    expect(click).toMatchObject({
      type: "click",
      ref,
      target: 'button#known "A"',
      count: 1,
    });
    expect(click.detail).toContain("client=5,7");
    expect(keydown).toMatchObject({
      type: "keydown",
      ref: null,
      detail: "key=a code=KeyA",
    });
  });

  test("logs moves only while armed and disarms on the next take", () => {
    document.body.innerHTML = '<div id="pad">Pad</div>';
    let pad = document.getElementById("pad")!;
    let move = (left: number) =>
      pad.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, clientX: left }),
      );
    takeEvents(true, false);
    move(1);
    expect(takeEvents(true, true)).toEqual([]);
    move(2);
    move(3);
    pad.dispatchEvent(new MouseEvent("mouseenter"));
    let armed = takeEvents(true, false);
    expect(armed.map((event) => [event.type, event.count])).toEqual([
      ["mousemove", 2],
      ["mouseenter", 1],
    ]);
    expect(armed[0].detail).toContain("client=3,");
    move(4);
    expect(takeEvents(true, false)).toEqual([]);
  });

  test("logs drag events that are always on", () => {
    takeEvents(true, false);
    document.body.innerHTML = '<div id="source" draggable="true">S</div>';
    let source = document.getElementById("source")!;
    for (let type of ["dragstart", "dragover", "drop", "dragend"])
      source.dispatchEvent(new Event(type, { bubbles: true }));
    expect(takeEvents(true, false).map((event) => event.type)).toEqual([
      "dragstart",
      "drop",
      "dragend",
    ]);
  });
});

describe("inspect", () => {
  test("reads form values, editable text and nothing for other elements", () => {
    document.body.innerHTML =
      '<input id="field" value="typed"><div id="edit" contenteditable="true">Edit me</div><p id="plain">P</p>';
    let byId = (id: string) => refFor(document.getElementById(id)!);
    expect(inspect(byId("field"))).toMatchObject({
      hover: false,
      value: "typed",
    });
    expect(inspect(byId("edit"))).toMatchObject({ value: "Edit me" });
    expect(inspect(byId("plain"))).toMatchObject({ value: null });
    expect(inspect(99999)).toMatchObject({ ok: false });
  });
});
