import type { EventsResult, LoggedEvent } from "../shared/protocol";
import { describe } from "./describe";
import { isWithin } from "./hit";
import { existingRef, resolveRef } from "./refs";

export let loggedTypes = [
  "pointerover",
  "pointerdown",
  "pointerup",
  "pointercancel",
  "mouseover",
  "mousedown",
  "mouseup",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
  "focusin",
  "focusout",
  "keydown",
  "keypress",
  "keyup",
  "beforeinput",
  "input",
  "change",
  "submit",
  "dragstart",
  "drop",
  "dragend",
];

// High-rate types are only listened for while armed, so ordinary browsing pays nothing per mouse move.
export let armedTypes = [
  "pointermove",
  "mousemove",
  "pointerenter",
  "mouseenter",
  "pointerleave",
  "mouseleave",
  "pointerout",
  "mouseout",
  "drag",
  "dragenter",
  "dragover",
  "dragleave",
];

// A key press logs up to 5 entries plus 2 per modifier, so 100 presses with three modifiers each (the key tool's worst case) fit.
let capacity = 1500;
let buffer: LoggedEvent[] = [];
let targets = new WeakMap<LoggedEvent, EventTarget>();
let armed = false;

export function record(entry: LoggedEvent) {
  buffer.push(entry);
  if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
}

// Consecutive entries of the same type, target and trust merge into one, keeping the first time and the latest detail.
export function recordCoalesced(entry: LoggedEvent) {
  let last = buffer[buffer.length - 1];

  if (
    !last ||
    last.type !== entry.type ||
    last.target !== entry.target ||
    last.isTrusted !== entry.isTrusted
  ) {
    record(entry);
    return;
  }

  last.count += 1;
  last.detail = entry.detail;
}

let armedListener = (event: Event) => recordCoalesced(toLogged(event));

function setArmed(on: boolean) {
  if (on === armed) return;
  armed = on;

  for (let type of armedTypes) {
    if (on)
      window.addEventListener(type, armedListener, {
        capture: true,
        passive: true,
      });
    else window.removeEventListener(type, armedListener, { capture: true });
  }
}

// Every take disarms; arm re-arms after the take so a measurement starts from an empty, armed log.
// document.open() erases a window's listeners (frames filled with document.write), so every take adds them again; duplicates are ignored.
// watch marks each event onTarget when it hit that element, one of its labels or an ancestor pressed for it; an unknown watch marks nothing.
export function takeEvents(
  clear: boolean,
  arm: boolean,
  watch: number | null = null,
): EventsResult {
  let events = clear ? buffer : buffer.slice();

  if (clear) buffer = [];

  installLogger();
  setArmed(false);
  setArmed(arm);
  let watched = watch === null ? null : resolveRef(watch);

  if (!(watched instanceof Element))
    return { ok: true, events, origin: performance.timeOrigin };

  let owners = [
    watched,
    ...Array.from((watched as HTMLInputElement).labels ?? []),
  ];
  let marked = events.map((event) => {
    let target = targets.get(event);
    let onTarget =
      target instanceof Node &&
      owners.some(
        (owner) =>
          isWithin(owner, target) ||
          (target instanceof Element && isWithin(target, owner)),
      );
    return { ...event, onTarget };
  });
  return { ok: true, events: marked, origin: performance.timeOrigin };
}

export function detailOf(event: Event) {
  if (event instanceof MouseEvent) {
    let pointer = event instanceof PointerEvent ? ` ${event.pointerType}` : "";
    return `button=${event.button} buttons=${event.buttons} client=${event.clientX},${event.clientY} detail=${event.detail}${pointer}`;
  }

  if (event instanceof KeyboardEvent)
    return `key=${event.key} code=${event.code}`;
  if (event instanceof InputEvent)
    return `inputType=${event.inputType}${event.data === null ? "" : ` data=${JSON.stringify(event.data)}`}`;
  return "";
}

let targetOf = (event: Event) => event.composedPath()[0] ?? event.target;

export function toLogged(event: Event): LoggedEvent {
  let target = targetOf(event);
  return {
    type: event.type,
    isTrusted: event.isTrusted,
    ref: target instanceof Element ? existingRef(target) : null,
    target: describe(target),
    time: Math.round((performance.timeOrigin + event.timeStamp) * 10) / 10,
    detail: detailOf(event),
    count: 1,
  };
}

function logListener(event: Event) {
  let entry = toLogged(event);
  let target = targetOf(event);

  if (target) targets.set(entry, target);

  record(entry);
}

export function installLogger() {
  for (let type of loggedTypes) {
    window.addEventListener(type, logListener, {
      capture: true,
      passive: true,
    });
  }
}
