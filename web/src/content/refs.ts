import type { Failure } from "../shared/protocol";

// Each document numbers its refs from a random thousand, so a ref kept from an earlier page is unknown in the next one and cannot name another element there.
let nextRef = 1 + Math.floor(Math.random() * 1000) * 1000;
let refsByElement = new WeakMap<Element, number>();
let elementsByRef = new Map<number, WeakRef<Element>>();

export function existingRef(element: Element) {
  return refsByElement.get(element) ?? null;
}

export function refFor(element: Element) {
  let known = refsByElement.get(element);
  if (known !== undefined) return known;
  let ref = nextRef++;
  refsByElement.set(element, ref);
  elementsByRef.set(ref, new WeakRef(element));
  return ref;
}

export function resolveRef(ref: number): Element | Failure {
  let weak = elementsByRef.get(ref);
  if (!weak) return { ok: false, error: `ref ${ref} is unknown` };
  let element = weak.deref();

  if (!element) {
    elementsByRef.delete(ref);
    return {
      ok: false,
      error: `ref ${ref} is gone (element was garbage collected)`,
    };
  }

  if (!element.isConnected)
    return { ok: false, error: `ref ${ref} is detached from the document` };
  return element;
}

export function pruneRefs() {
  for (let [ref, weak] of elementsByRef) {
    if (!weak.deref()) elementsByRef.delete(ref);
  }
}
