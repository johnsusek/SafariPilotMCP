import type { ElementInfo, Rect, SnapshotResult } from "../shared/protocol";
import { isEditableRoot, nameOf, roleOf } from "./describe";
import { flatElements, flatParent, isShown } from "./flat";
import {
  boxOf,
  intersect,
  readViewport,
  toRect,
  visibleArea,
} from "./geometry";
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
  if (tag === "input") return (element as HTMLInputElement).type !== "hidden";
  if (isWidget(element)) return true;
  let tabIndex = element.getAttribute("tabindex");
  if (tabIndex !== null && tabIndex.trim() !== "-1") return true;
  if (element.hasAttribute("onclick") || (element as HTMLElement).onclick)
    return true;
  if (isEditableRoot(element)) return true;

  // A label is clicked through its control, which locate counts it as part of, unless the control is not rendered.
  let control = tag === "label" ? (element as HTMLLabelElement).control : null;

  if (control && isShown(control)) return false;

  // Listeners added with addEventListener are invisible, so treat the outermost cursor:pointer element as clickable, unless a widget around it already is.
  if (getComputedStyle(element).cursor !== "pointer") return false;
  let parent = flatParent(element);

  if (parent && getComputedStyle(parent).cursor === "pointer") return false;

  for (let ancestor = parent; ancestor; ancestor = flatParent(ancestor)) {
    if (isWidget(ancestor)) return false;
  }

  return true;
}

function isWidget(element: Element) {
  let tag = element.localName;
  if (interactiveTags.has(tag) || tag === "input") return true;
  if (tag === "a" && element.hasAttribute("href")) return true;
  return widgetRoles.has(
    element.getAttribute("role")?.trim().split(/\s+/)[0] ?? "",
  );
}

// Rendered with a nonzero box; elements without one cannot be located.
export function hasBox(element: Element) {
  let box = boxOf(element);
  return box.width > 0 && box.height > 0;
}

export function elementInfo(
  element: Element,
  visible: Rect,
  name = nameOf(element),
): ElementInfo {
  let rect = toRect(boxOf(element));
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
