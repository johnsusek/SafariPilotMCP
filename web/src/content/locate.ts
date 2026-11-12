import type { Failure, LocateResult, Rect } from "../shared/protocol";
import { describe } from "./describe";
import {
  candidatePoints,
  intersect,
  pickPoint,
  readViewport,
  toRect,
  visibleArea,
} from "./geometry";
import { deepElementFromPoint, isWithin } from "./hit";
import { resolveRef } from "./refs";

let sameRect = (first: Rect, second: Rect) =>
  first.left === second.left &&
  first.top === second.top &&
  first.width === second.width &&
  first.height === second.height;

// Waits for the rect to hold still across two frames; rAF stalls in hidden tabs, so each frame also has a timeout.
async function settledRect(element: Element) {
  let previous = toRect(element.getBoundingClientRect());

  for (let frame = 0; frame < 30; frame++) {
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
      setTimeout(resolve, 100);
    });
    let current = toRect(element.getBoundingClientRect());
    if (sameRect(previous, current)) return current;
    previous = current;
  }

  return previous;
}

export async function locate(ref: number): Promise<LocateResult | Failure> {
  let element = resolveRef(ref);
  if (!(element instanceof Element)) return element;
  element.scrollIntoView({
    block: "center",
    inline: "nearest",
    behavior: "instant",
  });
  let rect = await settledRect(element);
  let viewport = readViewport();
  let center = {
    left: rect.left + rect.width / 2,
    top: rect.top + rect.height / 2,
  };
  // WebKit gives a checkbox or radio inside a label the label's AX frame, so report that rect for frame matching.
  let label =
    element instanceof HTMLInputElement &&
    (element.type === "checkbox" || element.type === "radio")
      ? element.closest("label")
      : null;
  let base = {
    ok: true as const,
    ref,
    rect: label ? toRect(label.getBoundingClientRect()) : rect,
    viewport,
  };
  if (rect.width <= 0 || rect.height <= 0)
    return {
      ...base,
      point: center,
      hitsTarget: false,
      hitDescription: "element has no box",
    };
  let clip = intersect(rect, visibleArea(viewport));
  if (!clip)
    return {
      ...base,
      point: center,
      hitsTarget: false,
      hitDescription: "element is outside the viewport",
    };
  let target = element;
  let point = pickPoint(rect, clip, (candidate) =>
    isWithin(target, deepElementFromPoint(candidate)),
  );
  if (point)
    return {
      ...base,
      point,
      hitsTarget: true,
      hitDescription: describe(deepElementFromPoint(point)),
    };
  let fallback = candidatePoints(rect, clip)[0];
  return {
    ...base,
    point: fallback,
    hitsTarget: false,
    hitDescription: `covered by ${describe(deepElementFromPoint(fallback))}`,
  };
}
