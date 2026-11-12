import type { ElementInfo, Failure, FindResult } from "../shared/protocol";
import { authorRoles, contentRoles, nameOf, roleOf } from "./describe";
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
    let inner =
      interactive || contentRoles.has(elementRole)
        ? [...flatElements(element)].filter(isInteractive)
        : [];
    // As in read_page, a clickable generic or group wrapping other widgets is not named by their text.
    let wraps = !contentRoles.has(elementRole) && inner.length > 0;
    let elementName = nameOf(
      element,
      (contentRoles.has(elementRole) ||
        (interactive && !authorRoles.has(elementRole))) &&
        !wraps,
    );

    // As in read_page, a widget around one widget of the same name is listed as the inner one, when that one matches too.
    let only = inner.length === 1 ? inner[0] : null;

    if (
      only &&
      nameOf(only) === elementName &&
      (!wantedRole || roleOf(only).toLowerCase() === wantedRole)
    )
      continue;

    if (needle && !elementName.toLowerCase().includes(needle)) continue;

    matches.push(elementInfo(element, visible, elementName));
  }

  return { ok: true, matches };
}
