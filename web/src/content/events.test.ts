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
  test("keeps the newest 1500 and clears on request", () => {
    takeEvents(true, false);
    for (let index = 0; index < 1520; index++) record(entry(index));
    let events = takeEvents(false, false).events;
    expect(events.length).toBe(1500);
    expect(events[0].target).toBe("t20");
    expect(events[1499].target).toBe("t1519");
    expect(takeEvents(true, false).events.length).toBe(1500);
    expect(takeEvents(false, false).events).toEqual([]);
  });

  test("replies with the document's time origin", () => {
    expect(takeEvents(true, false)).toMatchObject({
      ok: true,
      origin: performance.timeOrigin,
    });
  });

  test("coalesces consecutive identical entries", () => {
    takeEvents(true, false);
    recordCoalesced({ ...entry(1), type: "mousemove", detail: "first" });
    recordCoalesced({ ...entry(1), type: "mousemove", detail: "last" });
    recordCoalesced({ ...entry(1), type: "mousemove", isTrusted: true });
    recordCoalesced({ ...entry(2), type: "mousemove" });
    recordCoalesced({ ...entry(1), type: "mousemove" });
    let events = takeEvents(true, false).events;
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
    let [click, keydown] = takeEvents(true, false).events;
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
    expect(takeEvents(true, true).events).toEqual([]);
    move(2);
    move(3);
    pad.dispatchEvent(new MouseEvent("mouseenter"));
    let armed = takeEvents(true, false).events;
    expect(armed.map((event) => [event.type, event.count])).toEqual([
      ["mousemove", 2],
      ["mouseenter", 1],
    ]);
    expect(armed[0].detail).toContain("client=3,");
    move(4);
    expect(takeEvents(true, false).events).toEqual([]);
  });

  test("logs drag events that are always on", () => {
    takeEvents(true, false);
    document.body.innerHTML = '<div id="source" draggable="true">S</div>';
    let source = document.getElementById("source")!;
    for (let type of ["dragstart", "dragover", "drop", "dragend"])
      source.dispatchEvent(new Event(type, { bubbles: true }));
    expect(takeEvents(true, false).events.map((event) => event.type)).toEqual([
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
    expect(inspect(byId("plain"))).toMatchObject({
      value: null,
      kind: "other",
    });
    expect(inspect(99999)).toMatchObject({ ok: false });
  });

  test("reports the control kind, checked state and select options", () => {
    document.body.innerHTML = [
      '<input id="email" type="email"><input id="go" type="submit"><textarea id="area"></textarea>',
      '<input id="box" type="checkbox" checked><input id="dot" type="radio">',
      '<div id="aria" role="switch" aria-checked="true"></div>',
      '<select id="pick"><option value="1">One</option><option disabled>Two</option></select>',
      '<select id="many" multiple><option>A</option></select>',
      '<input id="when" type="time" value="11:05"><input id="day" type="date"><input id="stamp" type="datetime-local">',
    ].join("");
    let byId = (id: string) => refFor(document.getElementById(id)!);
    expect(inspect(byId("email"))).toMatchObject({ kind: "text" });
    expect(inspect(byId("go"))).toMatchObject({ kind: "other" });
    expect(inspect(byId("area"))).toMatchObject({ kind: "text" });
    expect(inspect(byId("box"))).toMatchObject({
      kind: "checkbox",
      checked: true,
    });
    expect(inspect(byId("dot"))).toMatchObject({
      kind: "radio",
      checked: false,
    });
    expect(inspect(byId("aria"))).toMatchObject({
      kind: "checkbox",
      checked: true,
    });
    expect(inspect(byId("pick"))).toMatchObject({
      kind: "select",
      value: "1",
      selectedIndex: 0,
      options: [
        { value: "1", label: "One", disabled: false },
        { value: "Two", label: "Two", disabled: true },
      ],
    });
    expect(inspect(byId("many"))).toMatchObject({ kind: "listbox" });
    expect(inspect(byId("when"))).toMatchObject({
      kind: "time",
      value: "11:05",
    });
    expect(inspect(byId("day"))).toMatchObject({ kind: "date", value: "" });
    expect(inspect(byId("stamp"))).toMatchObject({ kind: "datetime-local" });
  });
});

describe("watch", () => {
  installLogger();

  test("marks events on the watched element, its labels and its ancestors", () => {
    takeEvents(true, false);
    document.body.innerHTML =
      '<ul id="list"><li><button id="mine"><span id="inner">A</span></button></li><li><button id="other">B</button></li></ul><label for="box" id="label">Box</label><input id="box" type="checkbox">';
    let click = (id: string) =>
      document
        .getElementById(id)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    click("inner");
    click("list");
    click("other");
    let marks = takeEvents(
      true,
      false,
      refFor(document.getElementById("mine")!),
    )
      .events.filter((event) => event.type === "click")
      .map((event) => event.onTarget);
    expect(marks).toEqual([true, true, false]);
    click("label");
    let boxed = takeEvents(true, false, refFor(document.getElementById("box")!))
      .events.filter((event) => event.type === "click")
      .map((event) => [event.target, event.onTarget]);
    expect(boxed[0]).toEqual([expect.stringContaining("label"), true]);
    click("other");
    expect(
      takeEvents(true, false, 999999).events.every(
        (event) => event.onTarget === undefined,
      ),
    ).toBe(true);
  });
});
