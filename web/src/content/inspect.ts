import type { ControlKind, Failure, InspectResult } from "../shared/protocol";
import { resolveRef } from "./refs";
import { isSensitive } from "./sensitive";

let nonTextInputs = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "image",
  "file",
  "hidden",
]);

let dateTimeInputs = new Set(["date", "time", "datetime-local"]);

let ariaChecks: Record<string, ControlKind> = {
  checkbox: "checkbox",
  switch: "checkbox",
  radio: "radio",
};

export function inspect(ref: number): InspectResult | Failure {
  let element = resolveRef(ref);
  if (!(element instanceof Element)) return element;
  let base = {
    ok: true as const,
    ref,
    hover: element.matches(":hover"),
    value: null,
    secure: false,
    kind: "other" as ControlKind,
    checked: null,
    selectedIndex: null,
    options: null,
    min: null,
    max: null,
  };

  if (element instanceof HTMLSelectElement) {
    let options = [...element.options].map((option) => ({
      value: option.value,
      label: option.label ?? option.text,
      disabled: option.disabled,
    }));
    let listbox = element.multiple || element.size > 1;
    return {
      ...base,
      value: element.value,
      kind: listbox ? "listbox" : "select",
      selectedIndex: element.selectedIndex,
      options,
    };
  }

  if (
    element instanceof HTMLInputElement &&
    (element.type === "checkbox" || element.type === "radio")
  )
    return {
      ...base,
      value: element.value,
      kind: element.type,
      checked: element.checked,
    };

  // A native range reports min 0 and max 100 when unset; an ARIA slider may leave either out.
  if (element instanceof HTMLInputElement && element.type === "range")
    return {
      ...base,
      value: element.value,
      kind: "slider",
      min: Number(element.min || 0),
      max: Number(element.max || 100),
    };

  if (element.getAttribute("role") === "slider")
    return {
      ...base,
      value: element.getAttribute("aria-valuenow"),
      kind: "slider",
      min: numberOrNull(element.getAttribute("aria-valuemin")),
      max: numberOrNull(element.getAttribute("aria-valuemax")),
    };

  if (element instanceof HTMLInputElement && element.type === "color")
    return { ...base, value: element.value, kind: "color" };

  if (element instanceof HTMLInputElement && dateTimeInputs.has(element.type))
    return {
      ...base,
      value: element.value,
      kind: element.type as ControlKind,
    };

  // A secret's value never leaves the page: it reads back one bullet per character, as AX shows a password, which is enough to check what was set.
  if (isSensitive(element)) {
    let value =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
        ? element.value
        : (element.textContent ?? "");
    return {
      ...base,
      value: "\u2022".repeat(value.length),
      secure: true,
      kind: "text",
    };
  }

  if (element instanceof HTMLInputElement) {
    let kind: ControlKind = nonTextInputs.has(element.type) ? "other" : "text";
    return { ...base, value: element.value, kind };
  }

  if (element instanceof HTMLTextAreaElement)
    return { ...base, value: element.value, kind: "text" };

  if (element instanceof HTMLElement && element.isContentEditable)
    return { ...base, value: element.textContent ?? "", kind: "text" };

  let ariaKind = ariaChecks[element.getAttribute("role") ?? ""];

  if (ariaKind)
    return {
      ...base,
      kind: ariaKind,
      checked: element.getAttribute("aria-checked") === "true",
    };
  return base;
}

function numberOrNull(text: string | null) {
  if (text === null || text.trim() === "") return null;
  let number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function fire(element: Element, ...types: string[]) {
  for (let type of types)
    element.dispatchEvent(new Event(type, { bubbles: true }));
}

let settableInputs = new Set(["color", "range", ...dateTimeInputs]);

// Sets a color, range, date, time or datetime-local input from the page script, which needs no window made main or native control opened.
// The isolated world's value setter is the native one, so frameworks tracking the value (React) still see the change in the untrusted input and change events.
export function setValue(ref: number, value: string): InspectResult | Failure {
  let element = resolveRef(ref);
  if (!(element instanceof Element)) return element;

  if (
    !(element instanceof HTMLInputElement) ||
    !settableInputs.has(element.type)
  )
    return {
      ok: false,
      error: `ref ${ref} is not a color, range, date, time or datetime-local input`,
      code: "invalid_argument",
    };

  if (element.disabled || element.readOnly)
    return {
      ok: false,
      error: `${element.type} input ref ${ref} is ${element.disabled ? "disabled" : "read-only"}`,
      code: "not_actionable",
    };

  // WebKit takes any CSS color and stores its own serialization (green reads back #008000), but an unparsable one as #000000.
  if (element.type === "color" && !CSS.supports("color", value))
    return {
      ok: false,
      error: `"${value}" is not a CSS color`,
      code: "invalid_argument",
    };

  element.value = value;
  fire(element, "input", "change");
  return inspect(ref);
}

// Picks a select's option by index from the page script instead of the native menu, which brings its window forward; input and change are untrusted.
export function selectOption(
  ref: number,
  index: number,
): InspectResult | Failure {
  let element = resolveRef(ref);
  if (!(element instanceof Element)) return element;

  if (!(element instanceof HTMLSelectElement) || !element.options[index])
    return {
      ok: false,
      error: `ref ${ref} is not a select with an option ${index}`,
      code: "invalid_argument",
    };

  element.selectedIndex = index;
  fire(element, "input", "change");
  return inspect(ref);
}
