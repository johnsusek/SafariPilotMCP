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

// Pointer and mouse events as a real press sends them, untrusted, at the element's center: the pointer first moves in with over, enter and move events, and the press then goes
// to whatever is at that point, since mouseenter handlers may replace the element. A canceled pointerdown drops that press's mousedown and mouseup, a canceled mousedown keeps focus where it was, right clicks fire contextmenu after mousedown (as on macOS) and auxclick instead of click, and dblclick follows the second click.
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
  let aim = () => {
    let hit = deepElementFromPoint(point);
    return hit && (!element.isConnected || isWithin(element, hit))
      ? hit
      : element;
  };
  let target = aim();
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
  let make = (type: string, buttons: number, detail: number) => {
    // Enter events do not bubble.
    let init = { ...base, buttons, detail, bubbles: !type.endsWith("enter") };

    if (!type.startsWith("pointer")) return new MouseEvent(type, init);

    return new PointerEvent(type, {
      ...init,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: buttons ? 0.5 : 0,
    });
  };
  let fire = (type: string, buttons: number, detail: number) => {
    let canceled = !target.dispatchEvent(make(type, buttons, detail));
    dispatched.push({ type, canceled });
    return canceled;
  };
  // Each element the pointer enters gets its own enter event, outermost first.
  let enter = (type: string) => {
    let chain: Element[] = [];

    for (let at: Element | null = target; at; at = flatParent(at))
      chain.unshift(at);

    for (let at of chain) at.dispatchEvent(make(type, 0, 0));

    dispatched.push({ type, canceled: false });
  };

  fire("pointerover", 0, 0);
  enter("pointerenter");
  fire("mouseover", 0, 0);
  enter("mouseenter");
  fire("pointermove", 0, 0);
  fire("mousemove", 0, 0);
  target = aim();

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
