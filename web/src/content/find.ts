import type { ElementInfo, Failure, FindResult } from "../shared/protocol";
import { contentRoles, nameOf, roleOf } from "./describe";
import { flatElements } from "./flat";
import { readViewport, visibleArea } from "./geometry";
import { elementInfo, hasBox, isInteractive } from "./snapshot";

let limit = 20;

export function find(name: string, role: string): FindResult | Failure {
  let needle = name.trim().toLowerCase();
  let wantedRole = role.trim().toLowerCase();

  if (!needle && !wantedRole)
    return { ok: false, error: "find needs a name or a role" };

  let visible = visibleArea(readViewport());
  let matches: ElementInfo[] = [];

  for (let element of flatElements(document)) {
    if (matches.length >= limit) break;

    if (!hasBox(element)) continue;

    let elementRole = roleOf(element);

    if (wantedRole && elementRole.toLowerCase() !== wantedRole) continue;

    let interactive = isInteractive(element);
    // As in read_page, a clickable generic or group wrapping other widgets is not named by their text.
    let wraps =
      interactive &&
      !contentRoles.has(elementRole) &&
      [...flatElements(element)].some(isInteractive);
    let elementName = nameOf(
      element,
      (interactive || contentRoles.has(elementRole)) && !wraps,
    );

    if (needle && !elementName.toLowerCase().includes(needle)) continue;

    matches.push(elementInfo(element, visible, elementName));
  }

  return { ok: true, matches };
}
