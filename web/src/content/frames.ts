import type {
  Failure,
  FrameBoxResult,
  FrameEntry,
  FramesResult,
  HitFrameResult,
  Point,
  Rect,
} from "../shared/protocol";
import { describe } from "./describe";
import { flatElements, flatParent } from "./flat";
import { intersect, readViewport, toRect, visibleArea } from "./geometry";
import { deepElementFromPoint } from "./hit";
import { refFor, resolveRef } from "./refs";

let identities = [
  "matrix(1,0,0,1,0,0)",
  "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)",
];

// -1 when the iframe has no frame yet.
export function frameIdOf(iframe: HTMLIFrameElement) {
  try {
    return browser.runtime.getFrameId(iframe);
  } catch {
    return -1;
  }
}

// A sandbox without allow-scripts stops the page's own listeners, so nothing there can confirm a click or key.
export let blocksScripts = (iframe: HTMLIFrameElement) =>
  iframe.hasAttribute("sandbox") && !iframe.sandbox.contains("allow-scripts");

export function sourceOf(iframe: HTMLIFrameElement) {
  if (iframe.hasAttribute("srcdoc")) return "srcdoc";

  return iframe.src || "about:blank";
}

// AX lays a frame out as if no transform applied, so any transform on the iframe or around it, or a box scaled by CSS zoom, breaks frame matching.
function isTransformed(iframe: HTMLIFrameElement, bounds: DOMRect) {
  let scaled = (shown: number, laidOut: number) =>
    laidOut > 0 && Math.abs(shown / laidOut - 1) > 0.01;

  if (
    scaled(bounds.width, iframe.offsetWidth) ||
    scaled(bounds.height, iframe.offsetHeight)
  )
    return true;

  for (let node: Element | null = iframe; node; node = flatParent(node)) {
    let style = getComputedStyle(node);
    let moves = [style.transform, style.scale, style.rotate, style.translate]
      .map((value) => (value ?? "none").replace(/\s+/g, ""))
      .some(
        (value) =>
          value !== "none" && value !== "" && !identities.includes(value),
      );

    if (moves) return true;
  }

  return false;
}

export function frameEntry(iframe: HTMLIFrameElement): FrameEntry {
  let bounds = iframe.getBoundingClientRect();
  let style = getComputedStyle(iframe);
  let px = (value: string) => parseFloat(value) || 0;
  let left = px(style.paddingLeft);
  let top = px(style.paddingTop);
  let box = toRect(
    new DOMRect(
      bounds.left + iframe.clientLeft + left,
      bounds.top + iframe.clientTop + top,
      iframe.clientWidth - left - px(style.paddingRight),
      iframe.clientHeight - top - px(style.paddingBottom),
    ),
  );
  return {
    ref: refFor(iframe),
    frameId: frameIdOf(iframe),
    src: sourceOf(iframe),
    sandbox: iframe.getAttribute("sandbox"),
    box,
    clip: intersect(box, visibleArea(readViewport())),
    transformed: isTransformed(iframe, bounds),
  };
}

export function listFrames(): FramesResult {
  let frames = [...flatElements(document)]
    .filter((element) => element instanceof HTMLIFrameElement)
    .map(frameEntry);
  return {
    ok: true,
    url: location.href,
    title: document.title,
    viewport: readViewport(),
    frames,
  };
}

function iframeFor(ref: number): HTMLIFrameElement | Failure {
  let element = resolveRef(ref);

  if (!(element instanceof Element)) return element;

  if (!(element instanceof HTMLIFrameElement))
    return {
      ok: false,
      error: `ref ${ref} is a <${element.localName}>, not an iframe`,
    };

  return element;
}

let inside = (inner: Rect, outer: Rect) =>
  inner.left >= outer.left &&
  inner.top >= outer.top &&
  inner.left + inner.width <= outer.left + outer.width &&
  inner.top + inner.height <= outer.top + outer.height;

export function frameBox(
  ref: number,
  reveal: boolean,
): FrameBoxResult | Failure {
  let iframe = iframeFor(ref);

  if (!(iframe instanceof HTMLIFrameElement)) return iframe;

  let before = frameEntry(iframe);
  let moved = false;

  if (reveal && !inside(before.box, visibleArea(readViewport()))) {
    iframe.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
    moved = true;
  }

  return {
    ok: true,
    frame: moved ? frameEntry(iframe) : before,
    moved,
    viewport: readViewport(),
    origin: performance.timeOrigin,
  };
}

export function hitFrame(
  ref: number,
  points: Point[],
): HitFrameResult | Failure {
  let iframe = iframeFor(ref);

  if (!(iframe instanceof HTMLIFrameElement)) return iframe;

  let hits = points.map((point) => deepElementFromPoint(point) === iframe);
  let first = points[0] ? deepElementFromPoint(points[0]) : null;
  return { ok: true, hits, hitDescription: describe(first) };
}
