import type { Failure } from "../shared/protocol";

let nextRef = 1;
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
