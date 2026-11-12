// Flat tree helpers: shadow roots replace their host's light children, slots expand to their assigned nodes.
let skippedTags = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "link",
  "meta",
]);

export function flatParent(element: Element) {
  let parent = element.assignedSlot ?? element.parentNode;
  return parent instanceof ShadowRoot
    ? parent.host
    : (parent as Element | null);
}

export function flatChildren(node: Node): Node[] {
  if (node instanceof Element && node.shadowRoot)
    return Array.from(node.shadowRoot.childNodes);

  if (node instanceof HTMLSlotElement) {
    let assigned = node.assignedNodes();
    return assigned.length ? assigned : Array.from(node.childNodes);
  }

  return Array.from(node.childNodes);
}

// display:contents elements (slots by default) have no box, so checkVisibility is false for them though their children render.
export function isPruned(element: Element) {
  if (skippedTags.has(element.localName)) return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  if ((element as HTMLElement).hidden === true) return true;
  if (element.checkVisibility({ visibilityProperty: true })) return false;
  return getComputedStyle(element).display !== "contents";
}

export function* flatElements(root: Node): Generator<Element> {
  for (let child of flatChildren(root)) {
    if (!(child instanceof Element) || isPruned(child)) continue;

    yield child;
    yield* flatElements(child);
  }
}
