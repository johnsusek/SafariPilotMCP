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
  if (parent instanceof ShadowRoot) return parent.host;
  return parent instanceof Element ? parent : null;
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

// Whether element's whole subtree is left out. display:contents elements (slots by default) have no box, so checkVisibility is false for them though their children render.
export function isPruned(element: Element) {
  if (skippedTags.has(element.localName)) return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  if ((element as HTMLElement).hidden === true) return true;
  if (element.checkVisibility()) return false;
  return getComputedStyle(element).display !== "contents";
}

// visibility:hidden hides an element's own box and text but not a descendant that sets visibility:visible (Reddit's open menus), so the subtree is still walked.
export let isInvisible = (element: Element) =>
  /^(hidden|collapse)$/.test(getComputedStyle(element).visibility);

export let isShown = (element: Element) =>
  !isPruned(element) && !isInvisible(element);

// Whether element lays out as a block box, which separates the words around it; display:contents has no box of its own.
export let isBlock = (element: Element) =>
  !/^(inline|contents|$)/.test(getComputedStyle(element).display);

export function* flatElements(root: Node): Generator<Element> {
  for (let child of flatChildren(root)) {
    if (!(child instanceof Element) || isPruned(child)) continue;

    if (!isInvisible(child)) yield child;

    yield* flatElements(child);
  }
}
