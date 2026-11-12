import type { Point, Rect, Viewport } from "../shared/protocol";

let round = (value: number) => Math.round(value * 100) / 100;

export function toRect(box: DOMRect): Rect {
  return {
    left: round(box.left),
    top: round(box.top),
    width: round(box.width),
    height: round(box.height),
  };
}

export function readViewport(): Viewport {
  let visual = window.visualViewport!;
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    devicePixelRatio: window.devicePixelRatio,
    visualScale: visual.scale,
    visualOffsetLeft: visual.offsetLeft,
    visualOffsetTop: visual.offsetTop,
    visualWidth: visual.width,
    visualHeight: visual.height,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
  };
}

// The part of the layout viewport the user can actually see, in client coordinates.
export function visibleArea(viewport: Viewport): Rect {
  return {
    left: viewport.visualOffsetLeft,
    top: viewport.visualOffsetTop,
    width: viewport.visualWidth!,
    height: viewport.visualHeight!,
  };
}

export function intersect(first: Rect, second: Rect): Rect | null {
  let left = Math.max(first.left, second.left);
  let top = Math.max(first.top, second.top);
  let right = Math.min(first.left + first.width, second.left + second.width);
  let bottom = Math.min(first.top + first.height, second.top + second.height);
  if (right - left < 1 || bottom - top < 1) return null;
  return { left, top, width: right - left, height: bottom - top };
}

let fractions = [0.5, 0.25, 0.75, 0.1, 0.9];

// Center of the target (clamped into the visible clip) first, then a grid over the clip ordered by distance from that center.
export function candidatePoints(rect: Rect, clip: Rect): Point[] {
  let insetLeft = Math.min(2, clip.width / 4);
  let insetTop = Math.min(2, clip.height / 4);
  let clampLeft = (value: number) =>
    Math.min(
      Math.max(value, clip.left + insetLeft),
      clip.left + clip.width - insetLeft,
    );
  let clampTop = (value: number) =>
    Math.min(
      Math.max(value, clip.top + insetTop),
      clip.top + clip.height - insetTop,
    );
  let center = {
    left: clampLeft(rect.left + rect.width / 2),
    top: clampTop(rect.top + rect.height / 2),
  };
  let grid = fractions.flatMap((columnFraction) =>
    fractions.map((rowFraction) => ({
      left: clampLeft(clip.left + clip.width * columnFraction),
      top: clampTop(clip.top + clip.height * rowFraction),
    })),
  );
  let distance = (point: Point) =>
    Math.hypot(point.left - center.left, point.top - center.top);
  grid.sort((first, second) => distance(first) - distance(second));
  return [center, ...grid].map((point) => ({
    left: round(point.left),
    top: round(point.top),
  }));
}

export function pickPoint(
  rect: Rect,
  clip: Rect,
  hits: (point: Point) => boolean,
) {
  return candidatePoints(rect, clip).find(hits) ?? null;
}
