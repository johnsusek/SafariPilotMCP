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
  if (!element.checkVisibility())
    return getComputedStyle(element).display !== "contents";
  return isFlattened(getComputedStyle(element));
}

// A closed modal or menu is often scaled to nothing rather than hidden, which leaves it rendered but drawn at zero size.
function isFlattened(style: CSSStyleDeclaration) {
  if (style.scale.split(/\s+/).some((token) => parseFloat(token) === 0))
    return true;

  let matrix = style.transform.match(/^matrix(3d)?\(([^)]+)\)$/);

  if (!matrix) return false;

  let values = matrix[2].split(",").map(Number);
  let [a, b, c, d] = matrix[1]
    ? [values[0], values[1], values[4], values[5]]
    : values;
  return a * d - b * c === 0;
}

// visibility:hidden hides an element's own box and text but not a descendant that sets visibility:visible (Reddit's open menus), so the subtree is still walked.
export let isInvisible = (element: Element) =>
  /^(hidden|collapse)$/.test(getComputedStyle(element).visibility);

export let isShown = (element: Element) =>
  !isPruned(element) && !isInvisible(element);

// Whether element lays out as a block box, which separates the words around it; display:contents has no box of its own.
export let isBlock = (element: Element) =>
  !/^(inline|contents|$)/.test(getComputedStyle(element).display);

let spacing = [
  "margin-left",
  "margin-right",
  "padding-left",
  "padding-right",
  "border-left-width",
  "border-right-width",
];

let spaced = (style: CSSStyleDeclaration) =>
  spacing.some((property) => parseFloat(style.getPropertyValue(property)) > 0);

// Whether element sets its text apart: a block box, or an inline one with horizontal margin, padding or border (a badge), or a generated box
// with width or spacing before or after it (a separator dot drawn by ::before).
export function setsApart(element: Element) {
  if (isBlock(element) || spaced(getComputedStyle(element))) return true;

  return ["::before", "::after"].some((pseudo) => {
    let style = getComputedStyle(element, pseudo);

    if (/^(none|normal|)$/.test(style.content) || style.display === "none")
      return false;

    return spaced(style) || parseFloat(style.width) > 0;
  });
}

export function* flatElements(root: Node): Generator<Element> {
  for (let child of flatChildren(root)) {
    if (!(child instanceof Element) || isPruned(child)) continue;

    if (!isInvisible(child)) yield child;

    yield* flatElements(child);
  }
}
