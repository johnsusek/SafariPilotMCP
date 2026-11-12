// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { installLogger, record, takeEvents } from "./events";
import { refFor } from "./refs";

let entry = (index: number) => ({
  type: "click",
  isTrusted: false,
  ref: null,
  target: `t${index}`,
  time: index,
  detail: "",
});

describe("ring buffer", () => {
  test("keeps the newest 500 and clears on request", () => {
    takeEvents(true);
    for (let index = 0; index < 520; index++) record(entry(index));
    let events = takeEvents(false);
    expect(events.length).toBe(500);
    expect(events[0].target).toBe("t20");
    expect(events[499].target).toBe("t519");
    expect(takeEvents(true).length).toBe(500);
    expect(takeEvents(false)).toEqual([]);
  });
});

describe("logger", () => {
  test("records events with existing refs only", () => {
    installLogger();
    takeEvents(true);
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
    let [click, keydown] = takeEvents(true);
    expect(click).toMatchObject({
      type: "click",
      ref,
      target: 'button#known "A"',
    });
    expect(click.detail).toContain("client=5,7");
    expect(keydown).toMatchObject({
      type: "keydown",
      ref: null,
      detail: "key=a code=KeyA",
    });
  });
});
