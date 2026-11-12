import type { ElementInfo, Rect, SnapshotResult } from "../shared/protocol";
import { nameOf, roleOf } from "./describe";
import { flatElements, flatParent } from "./flat";
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

// Rendered with a nonzero box; elements without one cannot be located.
export function hasBox(element: Element) {
  let box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

export function elementInfo(
  element: Element,
  visible: Rect,
  name = nameOf(element),
): ElementInfo {
  let rect = toRect(element.getBoundingClientRect());
  let info: ElementInfo = {
    ref: refFor(element),
    tag: element.localName,
    role: roleOf(element),
    name,
    rect,
    inViewport: intersect(rect, visible) !== null,
  };

  if (
    (element as HTMLButtonElement).disabled === true ||
    element.getAttribute("aria-disabled") === "true"
  )
    info.disabled = true;

  return info;
}

export function snapshot(): SnapshotResult {
  pruneRefs();
  let viewport = readViewport();
  let visible = visibleArea(viewport);
  let elements: ElementInfo[] = [];

  for (let element of flatElements(document)) {
    if (!isInteractive(element) || !hasBox(element)) continue;

    elements.push(elementInfo(element, visible));
  }

  return {
    ok: true,
    url: location.href,
    title: document.title,
    viewport,
    elements,
  };
}
