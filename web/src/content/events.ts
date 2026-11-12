import type { LoggedEvent } from "../shared/protocol";
import { describe } from "./describe";
import { existingRef } from "./refs";

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

let capacity = 500;
let buffer: LoggedEvent[] = [];
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
export function takeEvents(clear: boolean, arm: boolean) {
  let events = clear ? buffer : buffer.slice();
  if (clear) buffer = [];
  setArmed(arm);
  return events;
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

export function toLogged(event: Event): LoggedEvent {
  let target = event.composedPath()[0] ?? event.target;
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

export function installLogger() {
  for (let type of loggedTypes) {
    window.addEventListener(type, (event) => record(toLogged(event)), {
      capture: true,
      passive: true,
    });
  }
}
