import type {
  ElementInfo,
  Failure,
  FindResult,
  TargetResult,
} from "../shared/protocol";
import { authorRoles, contentRoles, nameOf, roleOf } from "./describe";
import { flatElements } from "./flat";
import { readViewport, visibleArea } from "./geometry";
import { elementInfo, hasBox, isInteractive } from "./snapshot";

export let findLimit = 20;

export let onScreenFirst = <Match extends { inViewport: boolean }>(
  matches: Match[],
) => [
  ...matches.filter((match) => match.inViewport),
  ...matches.filter((match) => !match.inViewport),
];

// Exact name matches first, each group on-screen first.
export let exactFirst = <Match extends { exact: boolean; inViewport: boolean }>(
  matches: Match[],
) => [
  ...onScreenFirst(matches.filter((match) => match.exact)),
  ...onScreenFirst(matches.filter((match) => !match.exact)),
];

let query = (name: string, role: string) => ({
  needle: name.trim().toLowerCase(),
  wantedRole: role.trim().toLowerCase(),
});

let noQuery = (op: string): Failure => ({
  ok: false,
  error: `${op} needs a name or a role`,
  code: "invalid_argument",
});

// Rendered elements whose accessible name contains needle and whose role is wantedRole, both lowercase and either empty, in document order.
function* matching(needle: string, wantedRole: string) {
  for (let element of flatElements(document)) {
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
    let name = nameOf(
      element,
      (contentRoles.has(elementRole) ||
        (interactive && !authorRoles.has(elementRole))) &&
        !wraps,
    );

    // As in read_page, a widget around one widget of the same name is listed as the inner one, when that one matches too.
    let only = inner.length === 1 ? inner[0] : null;

    if (
      only &&
      nameOf(only) === name &&
      (!wantedRole || roleOf(only).toLowerCase() === wantedRole)
    )
      continue;

    if (needle && !name.toLowerCase().includes(needle)) continue;

    yield { element, name };
  }
}

export function find(name: string, role: string): FindResult | Failure {
  let { needle, wantedRole } = query(name, role);

  if (!needle && !wantedRole) return noQuery("find");

  let visible = visibleArea(readViewport());
  let matches: ElementInfo[] = [];
  let onScreen = 0;

  // On-screen matches come first, so a scrolled page's offscreen matches higher up never crowd them out of the cap.
  for (let match of matching(needle, wantedRole)) {
    let info = elementInfo(match.element, visible, match.name);
    matches.push(info);

    if (info.inViewport) onScreen++;

    if (onScreen >= findLimit) break;
  }

  return { ok: true, matches: onScreenFirst(matches).slice(0, findLimit) };
}

// Every match for an action's name and role, counted whole: exact ones, whose name equals name with case and surrounding whitespace ignored, come first,
// each group on-screen first. A role alone has no exact matches, since an unnamed element would equal the empty name.
export function target(name: string, role: string): TargetResult | Failure {
  let { needle, wantedRole } = query(name, role);

  if (!needle && !wantedRole) return noQuery("target");

  let visible = visibleArea(readViewport());
  let matches = [...matching(needle, wantedRole)].map((match) => ({
    ...elementInfo(match.element, visible, match.name),
    exact: needle !== "" && match.name.trim().toLowerCase() === needle,
  }));
  return {
    ok: true,
    matches: exactFirst(matches).slice(0, findLimit),
    matched: matches.length,
    exact: matches.filter((match) => match.exact).length,
  };
}
