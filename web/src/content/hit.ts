import type { Point } from "../shared/protocol";

// document.elementFromPoint stops at shadow hosts; descend through open shadow roots to the real hit.
export function deepElementFromPoint(point: Point) {
  let hit = document.elementFromPoint(point.left, point.top);

  while (hit?.shadowRoot) {
    let inner = hit.shadowRoot.elementFromPoint(point.left, point.top);
    if (!inner || inner === hit) break;
    hit = inner;
  }

  return hit;
}

// Walks the flat tree (slots and shadow hosts included) from node up to the root.
export function isWithin(target: Element, node: Node | null) {
  while (node) {
    if (node === target) return true;
    node =
      node instanceof ShadowRoot
        ? node.host
        : ((node as Element).assignedSlot ?? node.parentNode);
  }

  return false;
}
