import type { ControlKind, Failure, InspectResult } from "../shared/protocol";
import { resolveRef } from "./refs";

let nonTextInputs = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "image",
  "file",
  "hidden",
  "color",
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

  if (element instanceof HTMLInputElement && dateTimeInputs.has(element.type))
    return {
      ...base,
      value: element.value,
      kind: element.type as ControlKind,
    };

  // A password's value never leaves the page: it reads back one bullet per character, as AX shows it.
  if (element instanceof HTMLInputElement && element.type === "password")
    return {
      ...base,
      value: "\u2022".repeat(element.value.length),
      secure: true,
      kind: "text",
    };

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
