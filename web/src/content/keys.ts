import { isFrameHost } from "./frames";
import type {
  Failure,
  KeyPress,
  KeysResult,
  Modifier,
} from "../shared/protocol";
import { describe } from "./describe";
import { focusRef } from "./focus";
import { fire } from "./inspect";
import { refFor } from "./refs";

let modifierKeys: Record<Modifier, string> = {
  shift: "Shift",
  alt: "Alt",
  ctrl: "Control",
  cmd: "Meta",
};

let textInputs = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
]);

function active() {
  let found = document.activeElement;
  while (found?.shadowRoot?.activeElement)
    found = found.shadowRoot.activeElement;
  return found ?? document.body;
}

let isTextInput = (element: Element): element is HTMLInputElement =>
  element instanceof HTMLInputElement && textInputs.has(element.type);

function isEditable(element: Element) {
  if (isTextInput(element) || element instanceof HTMLTextAreaElement)
    return !element.disabled && !element.readOnly;
  return (element as HTMLElement).isContentEditable;
}

function tabbables() {
  let all = [
    ...document.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]",
    ),
  ].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !(element as HTMLInputElement).disabled &&
      (element as HTMLInputElement).type !== "hidden" &&
      element.getClientRects().length > 0,
  );
  let positive = all
    .filter((element) => element.tabIndex > 0)
    .sort((one, two) => one.tabIndex - two.tabIndex);
  return [...positive, ...all.filter((element) => element.tabIndex === 0)];
}

function moveFocus(from: Element, back: boolean) {
  let order = tabbables();
  if (order.length === 0) return null;
  let index = order.indexOf(from as HTMLElement);
  let next =
    index < 0
      ? order[back ? order.length - 1 : 0]
      : order[(index + (back ? -1 : 1) + order.length) % order.length];
  next.focus({ preventScroll: false });
  return `focused ${describe(next)}`;
}

function stepRange(input: HTMLInputElement, key: string) {
  let min = Number(input.min || 0);
  let max = Number(input.max || 100);
  let step = Number(input.step) || 1;
  let moves: Record<string, number> = {
    ArrowRight: step,
    ArrowUp: step,
    ArrowLeft: -step,
    ArrowDown: -step,
    PageUp: Math.max(step, (max - min) / 10),
    PageDown: -Math.max(step, (max - min) / 10),
    Home: -Infinity,
    End: Infinity,
  };
  if (moves[key] === undefined) return null;
  let before = input.value;
  let next = Math.min(max, Math.max(min, Number(before) + moves[key]));
  input.value = String(min + Math.round((next - min) / step) * step);
  if (input.value === before) return null;
  fire(input, "input", "change");
  return `set the range to ${input.value}`;
}

function stepSelect(select: HTMLSelectElement, down: boolean) {
  let index = select.selectedIndex;
  do index += down ? 1 : -1;
  while (select.options[index]?.disabled);
  if (!select.options[index]) return null;
  select.selectedIndex = index;
  fire(select, "input", "change");
  return `selected "${select.options[index].label}"`;
}

function moveCaret(element: Element, key: string, extend: boolean) {
  // A number field steps on ArrowUp and ArrowDown and has no selection to move.
  if (element instanceof HTMLInputElement && element.type === "number") {
    if (key !== "ArrowUp" && key !== "ArrowDown") return null;

    let before = element.value;

    if (key === "ArrowUp") element.stepUp();
    else element.stepDown();

    if (element.value === before) return null;

    fire(element, "input", "change");
    return `set the number to ${element.value}`;
  }

  if (isTextInput(element) || element instanceof HTMLTextAreaElement) {
    let field = element;
    let start = field.selectionStart ?? 0;
    let end = field.selectionEnd ?? 0;
    let length = field.value.length;
    let single = !(element instanceof HTMLTextAreaElement);
    let target =
      key === "ArrowLeft"
        ? Math.max(0, (start === end || extend ? start : start + 1) - 1)
        : key === "ArrowRight"
          ? Math.min(length, (start === end || extend ? end : end - 1) + 1)
          : key === "Home" || (single && key === "ArrowUp")
            ? 0
            : key === "End" || (single && key === "ArrowDown")
              ? length
              : null;

    if (target === null) {
      // A textarea's lines need layout, which the selection's own modify follows.
      getSelection()?.modify(
        extend ? "extend" : "move",
        key === "ArrowUp" ? "backward" : "forward",
        "line",
      );
      return "moved the caret";
    }

    if (extend)
      field.setSelectionRange(
        Math.min(start, target),
        Math.max(end, target),
        target < start ? "backward" : "forward",
      );
    else field.setSelectionRange(target, target);
    return "moved the caret";
  }

  let units: Record<string, [string, string]> = {
    ArrowLeft: ["backward", "character"],
    ArrowRight: ["forward", "character"],
    ArrowUp: ["backward", "line"],
    ArrowDown: ["forward", "line"],
    Home: ["backward", "lineboundary"],
    End: ["forward", "lineboundary"],
  };
  let unit = units[key];
  if (!unit) return null;
  getSelection()?.modify(extend ? "extend" : "move", unit[0], unit[1]);
  return "moved the caret";
}

function scrollPage(key: string, shift: boolean) {
  let page = document.scrollingElement ?? document.documentElement;
  let height = innerHeight * 0.875;
  let deltas: Record<string, number> = {
    ArrowDown: 40,
    ArrowUp: -40,
    PageDown: height,
    PageUp: -height,
    Space: shift ? -height : height,
    Home: -page.scrollHeight,
    End: page.scrollHeight,
  };
  if (deltas[key] === undefined) return null;
  let before = page.scrollTop;
  page.scrollBy({ top: deltas[key], behavior: "instant" });
  return page.scrollTop === before ? null : `scrolled to ${page.scrollTop}`;
}

// What a real press does when no listener canceled it, for the keys key accepts; null when it does nothing here.
function defaultAction(element: Element, press: KeyPress) {
  let held = (modifier: Modifier) => press.modifiers.includes(modifier);
  let editable = isEditable(element);

  if (press.character && !held("ctrl") && !held("cmd")) {
    if (editable) {
      document.execCommand("insertText", false, press.character);
      return "inserted text";
    }

    if (press.key !== " ") return null;
  }

  if (press.key === "Tab") return moveFocus(element, held("shift"));

  if (press.key === "Enter") {
    if (element instanceof HTMLTextAreaElement && editable) {
      document.execCommand("insertText", false, "\n");
      return "inserted a line break";
    }

    if (editable && (element as HTMLElement).isContentEditable) {
      document.execCommand(
        held("shift") ? "insertLineBreak" : "insertParagraph",
      );
      return "inserted a paragraph";
    }

    if (element instanceof HTMLInputElement && element.form) {
      element.form.requestSubmit();
      return "submitted its form";
    }

    if (element.matches("a[href], button, summary, [role=button]")) {
      (element as HTMLElement).click();
      return "clicked it";
    }

    return null;
  }

  if (press.key === " " || press.key === "Space") {
    if (
      element.matches(
        "button, summary, input[type=checkbox], input[type=radio], input[type=button], input[type=submit], input[type=reset], [role=button], [role=checkbox]",
      )
    ) {
      (element as HTMLElement).click();
      return "clicked it";
    }

    return scrollPage("Space", held("shift"));
  }

  if (press.key === "Backspace" || press.key === "Delete") {
    if (!editable) return null;
    document.execCommand(
      press.key === "Backspace" ? "delete" : "forwardDelete",
    );
    return "deleted";
  }

  if (element instanceof HTMLInputElement && element.type === "range")
    return stepRange(element, press.key);

  if (
    element instanceof HTMLSelectElement &&
    (press.key === "ArrowDown" || press.key === "ArrowUp")
  )
    return stepSelect(element, press.key === "ArrowDown");

  if (editable) return moveCaret(element, press.key, held("shift"));

  return scrollPage(press.key, held("shift"));
}

// Legacy keyCodes for named keys; a letter's or digit's is its uppercase character code.
let keyCodes: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Meta: 91,
};

// The physical key's code, for a US layout.
function codeOf(key: string) {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === " ") return "Space";
  if (Object.values(modifierKeys).includes(key)) return `${key}Left`;
  return key.length > 1 ? key : "";
}

// Pages that read keyCode, which or code (jQuery handlers, the-internet's key_presses) see the values a real press gives.
function keyboardEvent(type: string, key: string, modifiers: Modifier[]) {
  let printable = key.length === 1;
  let keyCode =
    type === "keypress"
      ? printable
        ? key.charCodeAt(0)
        : (keyCodes[key] ?? 0)
      : (keyCodes[key] ??
        (/^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0));
  // Passed in the init rather than defined on the event, which the page's world would not see; Safari's KeyboardEventInit takes them.
  return new KeyboardEvent(type, {
    key,
    code: codeOf(key),
    keyCode,
    which: keyCode,
    charCode: type === "keypress" && printable ? keyCode : 0,
    bubbles: true,
    cancelable: true,
    composed: true,
    shiftKey: modifiers.includes("shift"),
    altKey: modifiers.includes("alt"),
    ctrlKey: modifiers.includes("ctrl"),
    metaKey: modifiers.includes("cmd"),
  } as KeyboardEventInit);
}

// Presses keys as untrusted events at the focused element (after focusing ref when given) and runs each press's browser default unless a listener canceled it,
// so no window has to be made main or brought forward; pages that check isTrusted ignore them.
export function syntheticKeys(
  ref: number | null,
  presses: KeyPress[],
): KeysResult | Failure {
  if (ref !== null) {
    let focused = focusRef(ref);
    if (!focused.ok) return focused;
  }

  let start = active();
  let results: KeysResult["presses"] = [];

  for (let press of presses) {
    let element = active();

    if (isFrameHost(element))
      return {
        ok: false,
        error: `focus is inside iframe ${describe(element)}; pass a ref inside its frame, such as ${refFor(element)}:N`,
        code: "not_actionable",
      };

    let key = press.key === "Space" ? " " : (press.character ?? press.key);
    let held: Modifier[] = [];

    for (let modifier of press.modifiers) {
      held.push(modifier);
      element.dispatchEvent(
        keyboardEvent("keydown", modifierKeys[modifier], held),
      );
    }

    let canceled = !element.dispatchEvent(
      keyboardEvent("keydown", key, press.modifiers),
    );

    if (!canceled && (press.character || press.key === "Enter"))
      canceled = !element.dispatchEvent(
        keyboardEvent("keypress", key, press.modifiers),
      );

    let action = canceled
      ? null
      : defaultAction(element, {
          ...press,
          key: press.key === "Space" ? " " : press.key,
        });
    element.dispatchEvent(keyboardEvent("keyup", key, press.modifiers));

    for (let modifier of [...press.modifiers].reverse()) {
      held.pop();
      element.dispatchEvent(
        keyboardEvent("keyup", modifierKeys[modifier], held),
      );
    }

    results.push({ key: press.key, canceled, action });
  }

  return {
    ok: true,
    target: describe(start),
    presses: results,
    focused: describe(active()),
  };
}
