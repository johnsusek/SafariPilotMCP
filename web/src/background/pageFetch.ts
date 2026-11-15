// page_fetch: resolves the request (a URL, or a logged request to replay with its raw headers), applies the method and host guardrails, sends it from the
// page's main world and hides secrets in what comes back before anything leaves the extension.
import type {
  NetworkHeader,
  PageFetchRequest,
  PageFetchResult,
} from "../shared/commands";
import type { PageFetchAnswer } from "../shared/protocol";
import { redactBody, redactHeaders, redactUrl } from "../shared/redact";
import { type Send, thrown } from "./frames";
import { loggedOrigins, loggedRequest } from "./network";
import { parsePick, pickValue } from "./pick";

let refuse = (error: string): never => {
  throw thrown({ ok: false, error, code: "invalid_argument" });
};

// Fetch's forbidden request headers: fetch drops them and the browser sets them, from the page's own cookies and origin.
let forbidden = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

let isForbiddenHeader = (name: string) => {
  let lower = name.toLowerCase();
  return (
    forbidden.has(lower) ||
    lower.startsWith("proxy-") ||
    lower.startsWith("sec-")
  );
};

// Headers the browser adds on its own, which a replay leaves out: sent from script they can fail a cross-origin preflight, and the conditional ones would
// bring back the server's bodiless 304.
let browserAdded = new Set([
  "user-agent",
  "cache-control",
  "pragma",
  "priority",
  "upgrade-insecure-requests",
  "if-none-match",
  "if-modified-since",
]);

// Servers that honor these turn a GET into another method.
let methodOverrides = new Set([
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
]);

let token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// The page aborts the request after this, inside the 15 s a content send waits, so a hung endpoint cannot hold the command queue.
export let pageFetchTimeoutMs = 10000;
let readMethods = ["GET", "HEAD"];
// The General settings toggle that allows other methods, as PageFetchRequest.writesLabel in Shared/PageFetch.swift names it.
export let writesSetting = "Allow page_fetch Writes";

function withOverrides(
  headers: NetworkHeader[],
  overrides: Record<string, string | null>,
) {
  let merged = [...headers];

  for (let [name, value] of Object.entries(overrides)) {
    if (!token.test(name))
      refuse(`header name ${JSON.stringify(name)} is not a valid HTTP token`);
    if (isForbiddenHeader(name))
      refuse(
        `${name} cannot be set: the browser sends it, from the page's own cookies and origin`,
      );

    merged = merged.filter(
      (header) => header.name.toLowerCase() !== name.toLowerCase(),
    );

    if (value === null) continue;

    if (/[^\t\x20-\x7e\x80-\xff]/.test(value))
      refuse(
        `header ${name} has a line break, control character or character past U+00FF in its value`,
      );

    merged.push({ name, value });
  }

  return merged;
}

// Sets or removes (null) query parameters; with none the URL stays exactly as logged.
function withQuery(url: string, query: Record<string, string | null>) {
  if (Object.keys(query).length === 0) return url;

  let parsed = new URL(url);

  for (let [name, value] of Object.entries(query)) {
    if (value === null) parsed.searchParams.delete(name);
    else parsed.searchParams.set(name, value);
  }

  return parsed.href;
}

type Target = {
  url: string;
  method: string;
  frameId: number;
  headers: NetworkHeader[];
  body: string | null;
  replay: { url: string; method: string; time: number } | null;
  replayOf: string | null;
};

function resolve(
  tabId: number,
  tabUrl: string,
  request: PageFetchRequest,
): Target {
  if (request.requestId === null) {
    let url = URL.parse(request.url ?? "", tabUrl);

    if (!url)
      refuse(
        `url ${JSON.stringify(redactUrl(request.url ?? ""))} is not a URL, even relative to the tab's ${redactUrl(tabUrl)}`,
      );

    return {
      url: url!.href,
      method: (request.method ?? "GET").toUpperCase(),
      frameId: 0,
      headers: withOverrides([], request.headers),
      body: request.body,
      replay: null,
      replayOf: null,
    };
  }

  let entry = loggedRequest(tabId, request.requestId);
  return {
    url: withQuery(entry.rawUrl, request.query),
    method: entry.method,
    frameId: entry.frameId,
    headers: withOverrides(
      (entry.rawRequestHeaders ?? []).filter(
        ({ name }) =>
          !isForbiddenHeader(name) && !browserAdded.has(name.toLowerCase()),
      ),
      request.headers,
    ),
    body: request.body,
    replay: { url: entry.rawUrl, method: entry.method, time: entry.time },
    replayOf: entry.id,
  };
}

// Refuses what page_fetch does not send: a method or method override other than GET and HEAD unless writes, a body on GET or HEAD, any URL but http and
// https ones to the tab's own origin or an origin already in its network log (Safari logs nothing of a new tab's first load, so its own origin always counts).
function guard(
  target: Target,
  tabUrl: string,
  logged: Set<string>,
  writes: boolean,
) {
  let { method, url } = target;
  let named = `${method} ${redactUrl(url)}`;
  let ask = `page_fetch sends only GET and HEAD until your user turns on ${writesSetting} in SafariPilot's General settings; ask them, or send a GET`;

  if (!token.test(method))
    refuse(`method ${JSON.stringify(method)} is not an HTTP method`);
  if (["CONNECT", "TRACE", "TRACK"].includes(method))
    refuse(`${method} is a method fetch never sends`);

  if (!writes) {
    if (!readMethods.includes(method)) refuse(`${named} refused: ${ask}`);

    let override = target.headers.find(({ name }) =>
      methodOverrides.has(name.toLowerCase()),
    );

    if (override)
      refuse(
        `${override.name} refused: it asks the server for another method, and ${ask}`,
      );
  }

  if (target.body !== null && readMethods.includes(method))
    refuse(`${method} cannot carry a body; leave out body`);

  let parsed = new URL(url);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    refuse(
      `page_fetch sends only http and https requests, not ${parsed.protocol}`,
    );

  let own = URL.parse(tabUrl)?.origin ?? "null";

  if (parsed.origin !== own && !logged.has(parsed.origin))
    refuse(
      `${named} refused: page_fetch sends only to the tab's own origin (${own}) and origins already in its network log, and ${parsed.origin} is neither`,
    );
}

export async function runPageFetch(
  tab: { id: number; url?: string },
  send: Send,
  request: PageFetchRequest,
  writes: boolean,
): Promise<PageFetchResult> {
  let steps = request.pick === null ? null : parsePick(request.pick);
  let tabUrl = tab.url ?? "";
  let target = resolve(tab.id, tabUrl, request);
  guard(target, tabUrl, loggedOrigins(tab.id), writes);

  let named = `${target.method} ${redactUrl(target.url)}`;
  let answer = await send(target.frameId, {
    op: "pageFetch",
    url: target.url,
    method: target.method,
    headers: target.headers,
    body: target.body,
    replay: target.replay,
    timeoutMs: pageFetchTimeoutMs,
  });

  if (!answer.ok)
    throw thrown({ ...answer, error: `${named}: ${answer.error}` });

  let raw = answer as PageFetchAnswer;
  let status = `${raw.status}${raw.statusText ? ` ${raw.statusText}` : ""}`;
  let text = raw.body === null ? null : redactBody(raw.body);
  let shown = text;

  if (steps) {
    let sent = `${named} was sent and answered ${status}, but`;

    if (text === null)
      refuse(
        `${sent} pick needs a JSON body and it came back ${raw.binary ? `as ${raw.size} bytes of ${raw.contentType || "untyped data"}` : "without one"}`,
      );
    if (raw.truncated)
      refuse(
        `${sent} pick needs the whole JSON body and it was cut at ${raw.size} characters`,
      );

    let value: unknown;

    try {
      value = JSON.parse(text!);
    } catch {
      refuse(
        `${sent} pick needs a JSON body and the ${raw.contentType || "untyped"} body is not JSON`,
      );
    }

    try {
      shown = JSON.stringify(pickValue(value, steps)) ?? "null";
    } catch (error) {
      throw thrown({
        ok: false,
        error: `${sent} ${(error as Error).message}`,
        code: "invalid_argument",
      });
    }
  }

  let body = shown === null ? null : shown.slice(0, request.maxChars);
  return {
    ok: true,
    method: target.method,
    url: redactUrl(target.url),
    frameId: target.frameId,
    replayOf: target.replayOf,
    sentHeaders: target.headers.map(({ name }) => name),
    status: raw.status,
    statusText: raw.statusText,
    finalUrl: redactUrl(raw.url),
    redirected: raw.redirected,
    headers: redactHeaders(raw.headers),
    contentType: raw.contentType,
    binary: raw.binary,
    size: raw.size,
    truncated: raw.truncated,
    pick: request.pick,
    body,
    omitted: shown === null ? 0 : shown.length - body!.length,
  };
}
