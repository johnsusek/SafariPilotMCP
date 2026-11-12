import type { ElementInfo, Failure, FindResult } from "../shared/protocol";
import { roleOf } from "./describe";
import { flatElements } from "./flat";
import { readViewport, visibleArea } from "./geometry";
import { elementInfo, hasBox } from "./snapshot";
import { displayName } from "./tree";

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

    let elementName = displayName(element, elementRole);

    if (needle && !elementName.toLowerCase().includes(needle)) continue;

    matches.push(elementInfo(element, visible, elementName));
  }

  return { ok: true, matches };
}
