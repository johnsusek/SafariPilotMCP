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

// Inline sources (data:, blob:, javascript:) are named by their scheme alone, since the URL can run to kilobytes.
let inlineSchemes = ["data:", "blob:", "javascript:"];

export function sourceOf(iframe: HTMLIFrameElement) {
  if (iframe.hasAttribute("srcdoc")) return "srcdoc";

  if (!iframe.src) return "about:blank";

  let scheme = URL.canParse(iframe.src) ? new URL(iframe.src).protocol : "";
  return inlineSchemes.includes(scheme) ? scheme : iframe.src;
}

let tokens = (value: string) => value.trim().split(/\s+/);
let amount = (token: string) =>
  parseFloat(token) / (token.endsWith("%") ? 100 : 1);
// Computed values that leave a box where it is, per property; "none" and "" also do.
let stillValues: Record<string, (value: string) => boolean> = {
  transform: (value) => identities.includes(value.replace(/\s+/g, "")),
  translate: (value) => tokens(value).every((token) => amount(token) === 0),
  scale: (value) => tokens(value).every((token) => amount(token) === 1),
  rotate: (value) => amount(tokens(value).at(-1)!) === 0,
};

// AX lays a frame out as if no transform applied, so any transform on the iframe or around it, or a box scaled by CSS zoom, breaks frame matching.
// offsetWidth and offsetHeight are whole pixels, so a box differing by up to 1 px is not scaled.
function isTransformed(iframe: HTMLIFrameElement, bounds: DOMRect) {
  let scaled = (shown: number, laidOut: number) =>
    laidOut > 0 && Math.abs(shown - laidOut) > Math.max(1, laidOut * 0.01);

  if (
    scaled(bounds.width, iframe.offsetWidth) ||
    scaled(bounds.height, iframe.offsetHeight)
  )
    return true;

  for (let node: Element | null = iframe; node; node = flatParent(node)) {
    let style = getComputedStyle(node);
    let moves = Object.entries(stillValues).some(([property, still]) => {
      let value = style.getPropertyValue(property);
      return value !== "" && value !== "none" && !still(value);
    });

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

  if (!reveal || inside(before.box, visibleArea(readViewport())))
    return {
      ok: true,
      frame: before,
      moved: false,
      viewport: readViewport(),
      origin: performance.timeOrigin,
    };

  // nearest leaves an iframe larger than the viewport where it is once it covers the view, so moved compares the boxes.
  iframe.scrollIntoView({
    block: "nearest",
    inline: "nearest",
    behavior: "instant",
  });
  let after = frameEntry(iframe);
  return {
    ok: true,
    frame: after,
    moved:
      after.box.left !== before.box.left || after.box.top !== before.box.top,
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
