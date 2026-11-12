// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";
import { inspect, setColor } from "./inspect";
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

test("a color input is its own kind and setColor fires bubbling input and change", () => {
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
  expect(setColor(refFor(field), "#00ff00")).toMatchObject({
    kind: "color",
    value: "#00ff00",
  });
  expect(seen).toEqual(["input #00ff00", "change #00ff00"]);
});

test("setColor refuses other elements and disabled color inputs", () => {
  document.body.innerHTML =
    '<input type="text"><input type="color" disabled><input type="color">';
  let [text, color, open] = document.querySelectorAll("input");
  // happy-dom accepts any color, so WebKit's refusal is stubbed.
  vi.stubGlobal("CSS", { supports: () => false });
  expect(setColor(refFor(open), "not a color")).toMatchObject({
    ok: false,
    error: expect.stringContaining("not a CSS color"),
  });
  vi.unstubAllGlobals();
  expect(setColor(refFor(text), "#00ff00")).toMatchObject({
    ok: false,
    error: expect.stringContaining("not a color input"),
  });
  expect(setColor(refFor(color), "#00ff00")).toMatchObject({
    ok: false,
    error: expect.stringContaining("disabled"),
  });
});
