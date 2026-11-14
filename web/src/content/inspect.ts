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

// No AX path sets a color input: its AXColorWell ignores AXValue and opens a popover of unnamed swatches. The isolated world's
// value setter is the native one, so frameworks tracking the value (React) still see the change in the events.
export function setColor(ref: number, value: string): InspectResult | Failure {
  let element = resolveRef(ref);
  if (!(element instanceof Element)) return element;

  if (!(element instanceof HTMLInputElement) || element.type !== "color")
    return { ok: false, error: `ref ${ref} is not a color input` };

  if (element.disabled)
    return { ok: false, error: `color input ref ${ref} is disabled` };

  // WebKit takes any CSS color and stores its own serialization (green reads back #008000), but an unparsable one as #000000.
  if (!CSS.supports("color", value))
    return { ok: false, error: `"${value}" is not a CSS color` };

  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return inspect(ref);
}
