// Safari grants a web extension one site at a time, whatever its manifest asks for, unless the user chose "Always Allow on Every Website".
// Every assumption about how Safari behaves for a site it has not granted lives here, none of it verified live.
import type { Failure } from "../shared/protocol";
import { failureFrom, thrown, withTimeout } from "./frames";

// Safari has not granted the tab's site: prompt while it is asking the user, denied when refused or never allowed.
export type SiteAccess = "prompt" | "denied";

// tabs.get and executeScript wait on Safari's question (WebKit's requestPermissionToAccessURLs, up to 2 min) and answer at once otherwise.
export let accessDeadlineMs = 2000;

// WebKit's executeScript says "this extension does not have access to this tab", captureVisibleTab "granted host permissions for the current website are required".
let refusal = /does not have access|granted host permissions/i;

export let refused = (error: unknown) => refusal.test(String(error));

// The site Safari grants by: an http or https origin, null for pages with nothing to grant (about:, data:, file:) or an address Safari withheld.
export function siteOf(url: string | undefined) {
  if (!url || !URL.canParse(url)) return null;

  let parsed = new URL(url);
  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? parsed.origin
    : null;
}

export function accessFailure(
  siteAccess: SiteAccess,
  tabId: number | null,
  url?: string,
): Failure {
  let tab = tabId === null ? "the active tab" : `tab ${tabId}`;
  let site = siteOf(url) ?? `the site in ${tab}`;
  let settings = `Safari Settings > Extensions > SafariPilot, where "Always Allow on Every Website" grants every site at once`;
  let error =
    siteAccess === "prompt"
      ? `Safari is asking the user whether SafariPilot may use ${site} and holds every call for ${tab} until they answer. Ask your user to find Safari's permission prompt (it may be behind other windows, or waiting under the SafariPilot button in Safari's toolbar) and allow the site, or to use ${settings}; then retry.`
      : `Safari has not granted SafariPilot access to ${site} (refused, or never allowed). Ask your user to allow it from the SafariPilot button in Safari's toolbar or in ${settings}; then retry.`;
  return { ok: false, error, code: `site_access_${siteAccess}` };
}

// The access failure a thrown error carries, null for any other error.
export function accessFrom(error: unknown) {
  let failure = failureFrom(error);
  return failure?.code === "site_access_prompt" ||
    failure?.code === "site_access_denied"
    ? failure
    : null;
}

// Rethrows a refusal from a call Safari checks site access for as the denied failure.
export let refusing =
  (tabId: number, url: string | undefined) => (error: unknown) => {
    throw refused(error) ? thrown(accessFailure("denied", tabId, url)) : error;
  };

// A lookup still waiting after the deadline is held by Safari's question, since nothing else makes a tab lookup wait.
export async function withinAccess<Answer>(
  lookup: Promise<Answer>,
  tabId: number | null,
) {
  let answer = await withTimeout(lookup, accessDeadlineMs, "");

  if ((answer as Failure | null)?.code === "timed_out")
    throw thrown(accessFailure("prompt", tabId));

  return answer as Answer;
}

// Asked only after a page's top frame did not answer: a trivial script tells a site Safari has not granted from a tab whose content script is missing.
// Probing ahead is never done, since asking about a site raises Safari's prompt for it.
export async function probeAccess(tabId: number) {
  let probe = browser.scripting
    .executeScript({
      target: { tabId, frameIds: [0] },
      func: () => true,
    })
    .then(
      () => "granted" as const,
      (error) => (refused(error) ? ("denied" as const) : ("unknown" as const)),
    );
  let answer = await withTimeout(probe, accessDeadlineMs, "");
  return typeof answer === "string" ? answer : ("prompt" as const);
}
