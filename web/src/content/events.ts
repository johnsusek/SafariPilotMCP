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
  "keyup",
  "beforeinput",
  "input",
  "change",
  "submit",
];

let capacity = 500;
let buffer: LoggedEvent[] = [];

export function record(entry: LoggedEvent) {
  buffer.push(entry);
  if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
}

export function takeEvents(clear: boolean) {
  let events = buffer;
  if (clear) buffer = [];
  return clear ? events : events.slice();
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
