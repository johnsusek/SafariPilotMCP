import type { Failure, LocateResult, Rect } from "../shared/protocol";
import { describe } from "./describe";
import {
  candidatePoints,
  intersect,
  pickPoint,
  readViewport,
  toRect,
  unite,
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
  // WebKit gives a checkbox or radio the union of its own frame and its labels' frames, so report that rect for frame matching.
  let labels =
    element instanceof HTMLInputElement &&
    (element.type === "checkbox" || element.type === "radio")
      ? Array.from(element.labels ?? [])
      : [];
  let base = {
    ok: true as const,
    ref,
    rect: labels.reduce(
      (union, label) => unite(union, toRect(label.getBoundingClientRect())),
      rect,
    ),
    viewport,
  };
  if (rect.width <= 0 || rect.height <= 0)
    return {
      ...base,
      point: center,
      hitsTarget: false,
      covered: false,
      hitDescription: "element has no box",
    };
  let clip = intersect(rect, visibleArea(viewport));
  if (!clip)
    return {
      ...base,
      point: center,
      hitsTarget: false,
      covered: false,
      hitDescription: "element is outside the viewport",
    };
  // A custom checkbox or radio often sits under its own label, and a hit on the label reaches it.
  let owners = [
    element,
    ...Array.from((element as HTMLInputElement).labels ?? []),
  ];
  let point = pickPoint(rect, clip, (candidate) => {
    let hit = deepElementFromPoint(candidate);
    return owners.some((owner) => isWithin(owner, hit));
  });
  if (point)
    return {
      ...base,
      point,
      hitsTarget: true,
      covered: false,
      hitDescription: describe(deepElementFromPoint(point)),
    };
  let fallback = candidatePoints(rect, clip)[0];
  return {
    ...base,
    point: fallback,
    hitsTarget: false,
    covered: true,
    hitDescription: `covered by ${describe(deepElementFromPoint(fallback))}`,
  };
}
