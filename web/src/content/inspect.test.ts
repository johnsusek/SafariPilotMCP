// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";
import { inspect, selectOption, setValue } from "./inspect";
import { refFor } from "./refs";

test("a password reads back as bullets and is marked secure", () => {
  document.body.innerHTML = '<input type="password" value="hunter2">';
  let result = inspect(refFor(document.querySelector("input")!));
  expect(result).toMatchObject({
    kind: "text",
    secure: true,
    value: "•••••••",
  });
});

test("any secret field reads back as bullets, so form_input checks its length without the value", () => {
  document.body.innerHTML =
    '<input autocomplete="one-time-code" value="482913"><textarea name="api_token">sk-1</textarea><div contenteditable="true" aria-label="Password">abc</div><input aria-label="City" value="Lisbon">';
  let [code, token, editor, city] = document.querySelectorAll(
    "input, textarea, div",
  );
  expect(inspect(refFor(code))).toMatchObject({
    kind: "text",
    secure: true,
    value: "••••••",
  });
  expect(inspect(refFor(token))).toMatchObject({ secure: true, value: "••••" });
  expect(inspect(refFor(editor))).toMatchObject({ secure: true, value: "•••" });
  expect(inspect(refFor(city))).toMatchObject({
    secure: false,
    value: "Lisbon",
  });
});

test("a color input is its own kind and setValue fires bubbling input and change", () => {
  document.body.innerHTML = '<form><input type="color" value="#e66465"></form>';
  let field = document.querySelector("input")!;
  let seen: string[] = [];
  document
    .querySelector("form")!
    .addEventListener("input", () => seen.push(`input ${field.value}`));
  document
    .querySelector("form")!
    .addEventListener("change", () => seen.push(`change ${field.value}`));
  expect(inspect(refFor(field))).toMatchObject({
    kind: "color",
    value: "#e66465",
  });
  expect(setValue(refFor(field), "#00ff00")).toMatchObject({
    kind: "color",
    value: "#00ff00",
  });
  expect(seen).toEqual(["input #00ff00", "change #00ff00"]);
});

test("setValue refuses other elements and disabled color inputs", () => {
  document.body.innerHTML =
    '<input type="text"><input type="color" disabled><input type="color">';
  let [text, color, open] = document.querySelectorAll("input");
  // happy-dom accepts any color, so WebKit's refusal is stubbed.
  vi.stubGlobal("CSS", { supports: () => false });
  expect(setValue(refFor(open), "not a color")).toMatchObject({
    ok: false,
    error: expect.stringContaining("not a CSS color"),
    code: "invalid_argument",
  });
  vi.unstubAllGlobals();
  expect(setValue(refFor(text), "#00ff00")).toMatchObject({
    ok: false,
    error: expect.stringContaining(
      "not a color, range, date, time or datetime-local input",
    ),
    code: "invalid_argument",
  });
  expect(setValue(refFor(color), "#00ff00")).toMatchObject({
    ok: false,
    error: expect.stringContaining("disabled"),
    code: "not_actionable",
  });
});

test("setValue sets date, time and range inputs from the page", () => {
  document.body.innerHTML =
    '<input type="date"><input type="time"><input type="range" min="0" max="50" step="5" value="10">';
  let [date, time, range] = document.querySelectorAll("input");
  let changed: string[] = [];
  document.body.addEventListener("change", (event) =>
    changed.push((event.target as HTMLInputElement).type),
  );
  expect(setValue(refFor(date), "2026-11-20")).toMatchObject({
    value: "2026-11-20",
  });
  expect(setValue(refFor(time), "14:30")).toMatchObject({ value: "14:30" });
  expect(setValue(refFor(range), "35")).toMatchObject({ value: "35" });
  expect(changed).toEqual(["date", "time", "range"]);
});

test("selectOption picks by index and fires input and change", () => {
  document.body.innerHTML =
    "<select><option>One</option><option>Two</option></select>";
  let select = document.querySelector("select")!;
  let seen: string[] = [];
  select.addEventListener("input", () => seen.push("input"));
  select.addEventListener("change", () => seen.push("change"));
  expect(selectOption(refFor(select), 1)).toMatchObject({
    selectedIndex: 1,
    value: "Two",
  });
  expect(seen).toEqual(["input", "change"]);
  expect(selectOption(refFor(select), 5)).toMatchObject({
    ok: false,
    code: "invalid_argument",
  });
});

test("a range input and an ARIA slider are sliders with their bounds", () => {
  document.body.innerHTML =
    '<input type="range" min="5" max="50" value="10"><input type="range"><div role="slider" aria-valuenow="3.5" aria-valuemin="0"></div><div role="slider"></div>';
  let [range, plain, aria, bare] = document.querySelectorAll("input, div");
  expect(inspect(refFor(range))).toMatchObject({
    kind: "slider",
    value: "10",
    min: 5,
    max: 50,
  });
  expect(inspect(refFor(plain))).toMatchObject({
    kind: "slider",
    min: 0,
    max: 100,
  });
  expect(inspect(refFor(aria))).toMatchObject({
    kind: "slider",
    value: "3.5",
    min: 0,
    max: null,
  });
  expect(inspect(refFor(bare))).toMatchObject({
    kind: "slider",
    value: null,
    min: null,
    max: null,
  });
});

test("an editor that draws each line as a block reads back with its line breaks", () => {
  document.body.innerHTML =
    '<div contenteditable="true"><div class="cm-line">let index = 4;</div><div class="cm-line">log(index);</div></div>';
  let result = inspect(refFor(document.querySelector("[contenteditable]")!));
  expect(result).toMatchObject({
    kind: "text",
    value: "let index = 4;\nlog(index);",
  });
});
