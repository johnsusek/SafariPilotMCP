// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";
import type { KeyPress } from "../shared/protocol";
import { syntheticKeys } from "./keys";
import { refFor } from "./refs";

let press = (key: string, ...modifiers: KeyPress["modifiers"]): KeyPress => ({
  key,
  character: key.length === 1 ? key : null,
  modifiers,
});

let element = (id: string) => document.getElementById(id)!;

beforeEach(() => {
  document.body.innerHTML =
    '<form id="form"><input id="field"><input id="other"></form><input id="range" type="range" min="0" max="50" step="5" value="10"><select id="select"><option>One</option><option disabled>Off</option><option>Two</option></select><button id="button">Go</button>';
  // happy-dom lays nothing out, so every element counts as shown for Tab.
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
});

test("dispatches keydown, keypress and keyup and inserts text through execCommand", () => {
  let inserted: string[] = [];
  document.execCommand = (_command: string, _ui?: boolean, value?: string) => {
    inserted.push(value ?? "");
    return true;
  };
  let seen: string[] = [];
  let field = element("field");

  for (let type of ["keydown", "keypress", "keyup"])
    field.addEventListener(type, (event) =>
      seen.push(`${type} ${(event as KeyboardEvent).key}`),
    );

  let result = syntheticKeys(refFor(field), [press("a"), press("b")]);
  expect(result).toMatchObject({
    ok: true,
    presses: [
      { key: "a", canceled: false, action: "inserted text" },
      { key: "b", canceled: false, action: "inserted text" },
    ],
  });
  expect(inserted).toEqual(["a", "b"]);
  expect(seen.slice(0, 3)).toEqual(["keydown a", "keypress a", "keyup a"]);
});

test("a canceled keydown skips the default", () => {
  let field = element("field");
  field.addEventListener("keydown", (event) => event.preventDefault());
  let execCommand = vi.fn();
  document.execCommand = execCommand;
  expect(syntheticKeys(refFor(field), [press("a")])).toMatchObject({
    presses: [{ key: "a", canceled: true, action: null }],
  });
  expect(execCommand).not.toHaveBeenCalled();
});

test("Tab and shift+Tab move focus in tab order", () => {
  element("field").focus();
  expect(syntheticKeys(null, [press("Tab")])).toMatchObject({
    focused: expect.stringContaining("other"),
  });
  syntheticKeys(null, [press("Tab", "shift")]);
  expect(document.activeElement).toBe(element("field"));
});

test("modifier keydowns come before the key and carry their flags", () => {
  let seen: string[] = [];
  element("field").addEventListener("keydown", (event) =>
    seen.push(`${event.key} ${event.shiftKey}`),
  );
  syntheticKeys(refFor(element("field")), [press("Tab", "shift")]);
  expect(seen).toEqual(["Shift true", "Tab true"]);
});

test("Enter in a text input submits its form", () => {
  let submitted = vi.fn((event: Event) => event.preventDefault());
  element("form").addEventListener("submit", submitted);
  expect(
    syntheticKeys(refFor(element("field")), [press("Enter")]),
  ).toMatchObject({
    presses: [{ action: "submitted its form" }],
  });
  expect(submitted).toHaveBeenCalledOnce();
});

test("arrows step a range input and skip disabled select options", () => {
  let range = element("range") as HTMLInputElement;
  syntheticKeys(refFor(range), [press("ArrowRight"), press("ArrowRight")]);
  expect(range.value).toBe("20");
  syntheticKeys(refFor(range), [press("End")]);
  expect(range.value).toBe("50");
  let select = element("select") as HTMLSelectElement;
  syntheticKeys(refFor(select), [press("ArrowDown")]);
  expect(select.selectedIndex).toBe(2);
});

test("Space and Enter click a button", () => {
  let clicked = vi.fn();
  element("button").addEventListener("click", clicked);
  syntheticKeys(refFor(element("button")), [press("Space"), press("Enter")]);
  expect(clicked).toHaveBeenCalledTimes(2);
});

test("focus inside an iframe asks for a ref in its frame", () => {
  let frame = document.createElement("iframe");
  document.body.append(frame);
  frame.focus();
  expect(syntheticKeys(null, [press("a")])).toMatchObject({
    ok: false,
    code: "not_actionable",
  });
});

test("events carry the legacy keyCode, which, charCode and code a real press gives", () => {
  document.execCommand = () => true;
  let seen: string[] = [];
  // happy-dom drops the legacy fields Safari's KeyboardEventInit takes, so the init itself is checked.
  let Native = KeyboardEvent;
  vi.stubGlobal(
    "KeyboardEvent",
    class extends Native {
      constructor(type: string, init: KeyboardEventInit) {
        super(type, init);
        seen.push(
          `${type} ${init.keyCode} ${init.which} ${init.charCode} ${init.code}`,
        );
      }
    },
  );

  try {
    syntheticKeys(refFor(element("field")), [press("a"), press("Tab")]);
  } finally {
    vi.unstubAllGlobals();
  }

  expect(seen).toEqual([
    "keydown 65 65 0 KeyA",
    "keypress 97 97 97 KeyA",
    "keyup 65 65 0 KeyA",
    "keydown 9 9 0 Tab",
    "keyup 9 9 0 Tab",
  ]);
});

test("ArrowUp and ArrowDown step a number field", () => {
  document.body.innerHTML = '<input id="number" type="number" value="42">';
  let number = element("number") as HTMLInputElement;
  syntheticKeys(refFor(number), [press("ArrowUp"), press("ArrowUp")]);
  expect(number.value).toBe("44");
  syntheticKeys(refFor(number), [press("ArrowDown")]);
  expect(number.value).toBe("43");
});
