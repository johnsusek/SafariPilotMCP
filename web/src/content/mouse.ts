import type {
  ClickAction,
  ClickResult,
  Failure,
  Modifier,
} from "../shared/protocol";
import { describe, isEditableRoot } from "./describe";
import { flatParent } from "./flat";
import { deepElementFromPoint, isWithin } from "./hit";
import { resolveRef } from "./refs";

let presses: Record<ClickAction, number> = {
  left_click: 1,
  double_click: 2,
  triple_click: 3,
  right_click: 1,
};

let unfocusedInputs = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

// Safari on macOS moves focus on a press only to text fields, selects, editing hosts and tabindex elements; buttons, checkboxes, radios and links without tabindex stay unfocused.
function pressFocusable(element: Element) {
  if ((element as HTMLInputElement).disabled === true) return false;
  if (element instanceof HTMLInputElement)
    return !unfocusedInputs.has(element.type);
  if (element instanceof HTMLButtonElement) return false;
  if (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  )
    return true;
  return isEditableRoot(element) || element.hasAttribute("tabindex");
}

// A press focuses the nearest focusable element around the target, or blurs the focused one when there is none.
export function focusFor(target: Element) {
  for (
    let element: Element | null = target;
    element;
    element = flatParent(element)
  ) {
    if (!pressFocusable(element)) continue;

    (element as HTMLElement).focus({ preventScroll: true });
    return;
  }

  (document.activeElement as HTMLElement | null)?.blur?.();
}

// Pointer and mouse events as a real press sends them, untrusted, at the element's center: a canceled pointerdown drops that press's mousedown and mouseup,
// a canceled mousedown keeps focus where it was, right clicks fire contextmenu after mousedown (as on macOS) and auxclick instead of click, and dblclick follows the second click.
export function syntheticClick(
  ref: number,
  action: ClickAction,
  modifiers: Modifier[],
): ClickResult | Failure {
  let element = resolveRef(ref);
  if (!(element instanceof Element)) return element;

  let rect = element.getBoundingClientRect();
  let point = {
    left: rect.left + rect.width / 2,
    top: rect.top + rect.height / 2,
  };
  let hit = deepElementFromPoint(point);
  let target = hit && isWithin(element, hit) ? hit : element;
  let button = action === "right_click" ? 2 : 0;
  let held = action === "right_click" ? 2 : 1;
  let base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: point.left,
    clientY: point.top,
    screenX: window.screenX + point.left,
    screenY:
      window.screenY + window.outerHeight - window.innerHeight + point.top,
    button,
    ctrlKey: modifiers.includes("ctrl"),
    shiftKey: modifiers.includes("shift"),
    altKey: modifiers.includes("alt"),
    metaKey: modifiers.includes("cmd"),
  };
  let dispatched: ClickResult["dispatched"] = [];
  let fire = (type: string, buttons: number, detail: number) => {
    let init = { ...base, buttons, detail };
    let event = type.startsWith("pointer")
      ? new PointerEvent(type, {
          ...init,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          width: 1,
          height: 1,
          pressure: buttons ? 0.5 : 0,
        })
      : new MouseEvent(type, init);
    let canceled = !target.dispatchEvent(event);
    dispatched.push({ type, canceled });
    return canceled;
  };

  for (let count = 1; count <= presses[action]; count++) {
    let silenced = fire("pointerdown", held, 0);
    let prevented = !silenced && fire("mousedown", held, count);

    if (!prevented) focusFor(target);

    if (button === 2) fire("contextmenu", held, count);

    fire("pointerup", 0, 0);

    if (!silenced) fire("mouseup", 0, count);

    fire(button === 2 ? "auxclick" : "click", 0, count);

    if (count === 2) fire("dblclick", 0, 2);
  }

  return {
    ok: true,
    ref,
    target: describe(target),
    dispatched,
    focused: describe(document.activeElement),
  };
}
