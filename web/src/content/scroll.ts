import type { Failure, ScrollResult } from "../shared/protocol";
import { flatParent } from "./flat";
import { readViewport } from "./geometry";
import { resolveRef } from "./refs";

let scrollableOverflow = new Set(["auto", "scroll", "overlay"]);

// The nearest flat-tree ancestor (or the element itself) that can scroll along a requested axis, else the document.
export function scrollTarget(
  element: Element | null,
  left: number,
  top: number,
) {
  let page = document.scrollingElement ?? document.documentElement;

  for (let node = element; node && node !== page; node = flatParent(node)) {
    let style = getComputedStyle(node);
    let canLeft =
      left !== 0 &&
      scrollableOverflow.has(style.overflowX) &&
      node.scrollWidth > node.clientWidth;
    let canTop =
      top !== 0 &&
      scrollableOverflow.has(style.overflowY) &&
      node.scrollHeight > node.clientHeight;

    if (canLeft || canTop) return node;
  }

  return page;
}

export function scroll(
  ref: number | null,
  left: number,
  top: number,
): ScrollResult | Failure {
  let element = ref === null ? null : resolveRef(ref);

  if (element !== null && !(element instanceof Element)) return element;

  let target = scrollTarget(element, left, top);
  let before = [target.scrollLeft, target.scrollTop];
  target.scrollBy({ left, top, behavior: "instant" });
  let moved = target.scrollLeft !== before[0] || target.scrollTop !== before[1];
  return { ok: true, moved, viewport: readViewport() };
}

// Centers ref in the view, scrolling every container around it; moved is false when it was already there.
export function scrollIntoView(ref: number): ScrollResult | Failure {
  let element = resolveRef(ref);

  if (!(element instanceof Element)) return element;

  let before = element.getBoundingClientRect();
  element.scrollIntoView({
    block: "center",
    inline: "center",
    behavior: "instant",
  });
  let after = element.getBoundingClientRect();
  let moved = before.left !== after.left || before.top !== after.top;
  return { ok: true, moved, viewport: readViewport() };
}
