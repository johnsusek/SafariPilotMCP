import type { ElementInfo, SnapshotResult } from "../shared/protocol";
import { nameOf, roleOf } from "./describe";
import { intersect, readViewport, toRect, visibleArea } from "./geometry";
import { pruneRefs, refFor } from "./refs";

let interactiveTags = new Set(["button", "select", "textarea", "summary"]);

let widgetRoles = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "slider",
  "spinbutton",
  "treeitem",
]);

function* walk(root: ParentNode): Generator<Element> {
  for (let child of Array.from(root.children)) {
    yield child;
    if (child.shadowRoot) yield* walk(child.shadowRoot);
    yield* walk(child);
  }
}

function flatParent(element: Element) {
  let parent = element.assignedSlot ?? element.parentNode;
  return parent instanceof ShadowRoot
    ? parent.host
    : (parent as Element | null);
}

export function isInteractive(element: Element) {
  let tag = element.localName;
  if (interactiveTags.has(tag)) return true;
  if (tag === "a" && element.hasAttribute("href")) return true;
  if (tag === "input") return (element as HTMLInputElement).type !== "hidden";
  if (
    widgetRoles.has(element.getAttribute("role")?.trim().split(/\s+/)[0] ?? "")
  )
    return true;
  let tabIndex = element.getAttribute("tabindex");
  if (tabIndex !== null && tabIndex.trim() !== "-1") return true;
  if (element.hasAttribute("onclick") || (element as HTMLElement).onclick)
    return true;
  let html = element as HTMLElement;
  if (
    html.isContentEditable &&
    !(flatParent(element) as HTMLElement | null)?.isContentEditable
  )
    return true;

  // Listeners added with addEventListener are invisible, so treat the outermost cursor:pointer element as clickable.
  if (getComputedStyle(element).cursor !== "pointer") return false;
  let parent = flatParent(element);
  return !parent || getComputedStyle(parent).cursor !== "pointer";
}

export function snapshot(): SnapshotResult {
  pruneRefs();
  let viewport = readViewport();
  let visible = visibleArea(viewport);
  let elements: ElementInfo[] = [];

  for (let element of walk(document)) {
    if (!isInteractive(element)) continue;
    let rect = toRect(element.getBoundingClientRect());
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (!element.checkVisibility({ visibilityProperty: true })) continue;
    let info: ElementInfo = {
      ref: refFor(element),
      tag: element.localName,
      role: roleOf(element),
      name: nameOf(element),
      rect,
      inViewport: intersect(rect, visible) !== null,
    };
    if (
      (element as HTMLButtonElement).disabled === true ||
      element.getAttribute("aria-disabled") === "true"
    )
      info.disabled = true;
    elements.push(info);
  }

  return {
    ok: true,
    url: location.href,
    title: document.title,
    viewport,
    elements,
  };
}
