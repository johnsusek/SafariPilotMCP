import type { DragResult, Failure, Point } from "../shared/protocol";
import { describe } from "./describe";
import { flatParent } from "./flat";
import { deepElementFromPoint, isWithin } from "./hit";
import { focusFor } from "./mouse";
import { resolveRef } from "./refs";

let steps = 10;

let centerOf = (element: Element) => {
  let rect = element.getBoundingClientRect();
  return { left: rect.left + rect.width / 2, top: rect.top + rect.height / 2 };
};

// A hidden page renders no frames and Safari runs its timers about once a second, which would stretch a drag past the content timeout,
// so there each step only yields to the page's own tasks through a message, which is not throttled.
let nextFrame = () =>
  new Promise((resolve) => {
    if (document.visibilityState === "hidden") {
      let channel = new MessageChannel();
      channel.port1.onmessage = resolve;
      channel.port2.postMessage(null);
      return;
    }

    requestAnimationFrame(resolve);
    setTimeout(resolve, 20);
  });

function ancestors(element: Element) {
  let chain: Element[] = [];

  for (let node: Element | null = element; node; node = flatParent(node))
    chain.push(node);

  return chain;
}

// The nearest element around the hit that a press would start an HTML5 drag from: draggable="true", a link or an image.
function dragSource(hit: Element) {
  for (let node: Element | null = hit; node; node = flatParent(node))
    if ((node as HTMLElement).draggable === true) return node;

  return null;
}

// What a press on ref and a drag to the center of to send, as untrusted events paced one per animation frame: pointerdown and mousedown, then an HTML5 drag
// (dragstart with a constructed DataTransfer, drag, dragenter, dragover and dragleave per element under the pointer, drop only after a canceled dragover, dragend)
// when the pressed element is draggable and dragstart is not canceled, else pointer and mouse moves with over and out transitions, then pointerup, mouseup and click.
export async function drag(
  ref: number,
  to: number,
): Promise<DragResult | Failure> {
  let element = resolveRef(ref);
  if (!(element instanceof Element)) return element;

  let goal = resolveRef(to);
  if (!(goal instanceof Element)) return goal;

  goal.scrollIntoView({
    block: "nearest",
    inline: "nearest",
    behavior: "instant",
  });
  await nextFrame();
  let start = centerOf(element);
  let end = centerOf(goal);
  let first = deepElementFromPoint(start);
  let last = deepElementFromPoint(end);

  if (!first || !isWithin(element, first) || !last || !isWithin(goal, last))
    return {
      ok: false,
      error: `ref ${ref} ${describe(element)} and ref ${to} ${describe(goal)} are not both hittable on screen at once (one is covered or they do not fit in the viewport together), so nothing was sent`,
      code: "not_actionable",
    };

  let dispatched: DragResult["dispatched"] = [];
  let record = (type: string, canceled: boolean) => {
    let previous = dispatched.at(-1);

    if (previous?.type === type) {
      previous.count++;
      previous.canceled ||= canceled;
    } else dispatched.push({ type, canceled, count: 1 });

    return canceled;
  };
  let mouseInit = (point: Point, buttons: number, bubbles = true) => ({
    bubbles,
    cancelable: bubbles,
    composed: true,
    view: window,
    clientX: point.left,
    clientY: point.top,
    screenX: window.screenX + point.left,
    screenY:
      window.screenY + window.outerHeight - window.innerHeight + point.top,
    button: 0,
    buttons,
  });
  let fire = (
    target: Element,
    type: string,
    point: Point,
    buttons: number,
    bubbles = true,
  ) => {
    let init = mouseInit(point, buttons, bubbles);
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
      : new MouseEvent(type, { ...init, detail: type === "click" ? 1 : 0 });
    return record(type, !target.dispatchEvent(event));
  };
  let transfer = new DataTransfer();
  let fireDrag = (target: Element, type: string, point: Point) =>
    record(
      type,
      !target.dispatchEvent(
        new DragEvent(type, {
          ...mouseInit(point, type === "dragend" ? 0 : 1),
          cancelable: type !== "dragleave" && type !== "dragend",
          dataTransfer: transfer,
        }),
      ),
    );
  let silenced = fire(first, "pointerdown", start, 1);
  let prevented = !silenced && fire(first, "mousedown", start, 1);

  if (!prevented) focusFor(first);

  // A canceled mousedown keeps an HTML5 drag from starting.
  let source = prevented ? null : dragSource(first);
  let pointed = first;
  let dropTarget: Element | null = null;
  let accepted = false;
  // Moving onto another element sends out and over to the two, and leave and enter, which do not bubble, to each element only one of them is inside.
  let moveTo = (hit: Element, point: Point) => {
    if (hit !== pointed) {
      let left = ancestors(pointed);
      let entered = ancestors(hit);
      fire(pointed, "pointerout", point, 1);

      if (!silenced) fire(pointed, "mouseout", point, 1);

      for (let node of left.filter((node) => !entered.includes(node))) {
        fire(node, "pointerleave", point, 1, false);

        if (!silenced) fire(node, "mouseleave", point, 1, false);
      }

      fire(hit, "pointerover", point, 1);

      if (!silenced) fire(hit, "mouseover", point, 1);

      for (let node of entered
        .filter((node) => !left.includes(node))
        .reverse()) {
        fire(node, "pointerenter", point, 1, false);

        if (!silenced) fire(node, "mouseenter", point, 1, false);
      }

      pointed = hit;
    }

    fire(hit, "pointermove", point, 1);

    if (!silenced) fire(hit, "mousemove", point, 1);
  };

  if (source instanceof HTMLAnchorElement && source.href) {
    transfer.setData("text/uri-list", source.href);
    transfer.setData("text/plain", source.href);
  } else if (source instanceof HTMLImageElement && source.src)
    transfer.setData("text/uri-list", source.src);

  for (let step = 1; step <= steps; step++) {
    await nextFrame();
    let point = {
      left: start.left + ((end.left - start.left) * step) / steps,
      top: start.top + ((end.top - start.top) * step) / steps,
    };
    let hit = deepElementFromPoint(point) ?? document.documentElement;

    // The first move past the press starts the HTML5 drag; a canceled dragstart leaves an ordinary pointer drag.
    if (step === 1 && source) {
      moveTo(first, start);

      if (fireDrag(source, "dragstart", start)) source = null;
      else fire(pointed, "pointercancel", start, 0);
    }

    if (!source) {
      moveTo(hit, point);
      continue;
    }

    fireDrag(source, "drag", point);

    if (hit !== dropTarget) {
      fireDrag(hit, "dragenter", point);

      if (dropTarget) fireDrag(dropTarget, "dragleave", point);

      dropTarget = hit;
    }

    accepted = fireDrag(hit, "dragover", point);
  }

  let landed = source ? dropTarget! : pointed;
  let dropped = false;

  if (source && accepted) {
    fireDrag(landed, "drop", end);
    dropped = true;
  } else if (source) fireDrag(landed, "dragleave", end);

  if (source) fireDrag(source, "dragend", end);
  else {
    fire(landed, "pointerup", end, 0);

    if (!silenced) fire(landed, "mouseup", end, 0);

    let common = ancestors(first).find((node) => isWithin(node, landed));

    if (common) fire(common, "click", end, 0);
  }

  return {
    ok: true,
    ref,
    to,
    source: describe(source ?? first),
    target: describe(landed),
    html5: source !== null,
    dropped,
    dispatched,
  };
}
