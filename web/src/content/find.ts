import type { ElementInfo, Failure, FindResult } from "../shared/protocol";
import { roleOf } from "./describe";
import { flatElements } from "./flat";
import { readViewport, visibleArea } from "./geometry";
import { isWithin } from "./hit";
import { elementInfo, hasBox } from "./snapshot";
import { displayName } from "./tree";

let limit = 20;

function ownText(element: Element) {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent)
    .join(" ");
}

// Matches inside an element that already matched are skipped, so a link and its inner span count once.
export function find(query: string): FindResult | Failure {
  let needle = query.trim().toLowerCase();

  if (!needle) return { ok: false, error: "find needs a non-empty query" };

  let visible = visibleArea(readViewport());
  let matched: Element[] = [];
  let matches: ElementInfo[] = [];

  for (let element of flatElements(document)) {
    if (matches.length >= limit) break;

    if (!hasBox(element)) continue;

    let role = roleOf(element);
    let name = displayName(element, role);
    let haystack = [
      role,
      name,
      ownText(element),
      element.getAttribute("placeholder") ?? "",
    ];

    if (!haystack.some((value) => value.toLowerCase().includes(needle)))
      continue;

    if (matched.some((outer) => isWithin(outer, element))) continue;

    matched.push(element);
    matches.push(elementInfo(element, visible, name));
  }

  return { ok: true, matches };
}
