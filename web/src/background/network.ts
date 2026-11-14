// The request log for pilot tabs: tabs tabCreate opened and tabs they opened, kept in session storage so a background Safari unloaded and woke knows them again.
// webRequest listeners are added only while a pilot tab is open or one is being created, so the user's own browsing never wakes or reaches this code.
import type {
  NetworkEntry,
  NetworkHeader,
  NetworkRequestResult,
  NetworkResult,
} from "../shared/commands";
import type { Failure, NetworkBodyResult } from "../shared/protocol";
import { redactBody, redactHeaders, redactUrl } from "../shared/redact";
import { type Send, thrown } from "./frames";

type Recorded = NetworkEntry & {
  rawUrl: string;
  requestHeaders: NetworkHeader[] | null;
  responseHeaders: NetworkHeader[] | null;
};
type Log = { entries: Recorded[]; dropped: number };
type Details = {
  requestId: string;
  tabId: number;
  frameId: number;
  url: string;
  method: string;
  type: string;
  timeStamp: number;
  statusCode?: number;
  statusLine?: string;
  fromCache?: boolean;
  redirectUrl?: string;
  error?: string;
  requestHeaders?: { name: string; value?: string }[];
  responseHeaders?: { name: string; value?: string }[];
};

export let maxRequests = 500;

let pilotTabs = new Set<number>();
let logs = new Map<number, Log>();
// While a tab is being created its id is unknown, so requests of tabs not yet piloted wait here; the created tab's are kept and the rest dropped.
let pending = new Map<number, Log>();
let creating = 0;
// webRequest's requestId to the entry it is filling; a redirect ends the entry and the request's next hop starts another under the same requestId.
let open = new Map<string, { tabId: number; entry: Recorded }>();
let nextId = 1;
let listening = false;
let filter = { urls: ["<all_urls>"] };

let save = () =>
  browser.storage.session.set({ pilotTabs: [...pilotTabs] }).catch(() => {});

let logFor = (tabId: number) => {
  if (pilotTabs.has(tabId)) {
    let log = logs.get(tabId) ?? { entries: [], dropped: 0 };
    logs.set(tabId, log);
    return log;
  }

  if (creating === 0 || tabId < 0) return null;

  let log = pending.get(tabId) ?? { entries: [], dropped: 0 };
  pending.set(tabId, log);
  return log;
};

let onBeforeRequest = (details: Details) => {
  let log = logFor(details.tabId);

  if (!log) return;

  let entry: Recorded = {
    id: String(nextId++),
    frameId: details.frameId,
    method: details.method,
    url: redactUrl(details.url),
    rawUrl: details.url,
    type: details.type,
    time: details.timeStamp,
    status: null,
    statusLine: "",
    fromCache: false,
    duration: null,
    redirect: null,
    error: null,
    requestHeaders: null,
    responseHeaders: null,
  };

  if (log.entries.length >= maxRequests) {
    log.entries.shift();
    log.dropped++;
  }

  log.entries.push(entry);
  open.set(details.requestId, { tabId: details.tabId, entry });
};

let onSendHeaders = (details: Details) => {
  let entry = open.get(details.requestId)?.entry;

  if (entry && details.requestHeaders)
    entry.requestHeaders = redactHeaders(details.requestHeaders);
};

// A response that ends the entry: completed, or redirected to another hop.
let respond = (details: Details) => {
  let entry = open.get(details.requestId)?.entry;

  if (!entry) return null;

  open.delete(details.requestId);
  entry.status = details.statusCode ?? null;
  entry.statusLine = details.statusLine ?? "";
  entry.fromCache = details.fromCache === true;
  entry.duration = Math.round(details.timeStamp - entry.time);
  entry.responseHeaders = details.responseHeaders
    ? redactHeaders(details.responseHeaders)
    : null;
  return entry;
};

let onCompleted = (details: Details) => {
  respond(details);
};

let onBeforeRedirect = (details: Details) => {
  let entry = respond(details);

  if (entry && details.redirectUrl)
    entry.redirect = redactUrl(details.redirectUrl);
};

let onErrorOccurred = (details: Details) => {
  let entry = open.get(details.requestId)?.entry;

  if (!entry) return;

  open.delete(details.requestId);
  entry.error = details.error ?? "failed";
  entry.duration = Math.round(details.timeStamp - entry.time);
};

// Listens exactly while there is a pilot tab or a tab being created.
let updateListening = () => {
  let wanted = pilotTabs.size > 0 || creating > 0;

  if (wanted === listening) return;

  listening = wanted;
  let events = browser.webRequest;

  if (wanted) {
    events.onBeforeRequest.addListener(onBeforeRequest as never, filter);
    events.onSendHeaders.addListener(onSendHeaders as never, filter, [
      "requestHeaders",
    ]);
    events.onBeforeRedirect.addListener(onBeforeRedirect as never, filter, [
      "responseHeaders",
    ]);
    events.onCompleted.addListener(onCompleted as never, filter, [
      "responseHeaders",
    ]);
    events.onErrorOccurred.addListener(onErrorOccurred as never, filter);
    return;
  }

  events.onBeforeRequest.removeListener(onBeforeRequest as never);
  events.onSendHeaders.removeListener(onSendHeaders as never);
  events.onBeforeRedirect.removeListener(onBeforeRedirect as never);
  events.onCompleted.removeListener(onCompleted as never);
  events.onErrorOccurred.removeListener(onErrorOccurred as never);
  open.clear();
};

let pilot = (tabId: number) => {
  if (pilotTabs.has(tabId)) return;

  pilotTabs.add(tabId);
  logs.set(tabId, pending.get(tabId) ?? { entries: [], dropped: 0 });
  pending.delete(tabId);
  save();
  updateListening();
};

export let forget = (tabId: number) => {
  pending.delete(tabId);

  if (!pilotTabs.delete(tabId)) return;

  logs.delete(tabId);

  for (let [requestId, request] of open)
    if (request.tabId === tabId) open.delete(requestId);

  save();
  updateListening();
};

// Runs create, which answers with the new tab, with listeners on from before it starts, so the tab's first request is logged.
export async function piloting<Tab extends { id: number }>(
  create: () => Promise<Tab>,
) {
  creating++;
  updateListening();

  try {
    let tab = await create();
    pilot(tab.id);
    return tab;
  } finally {
    creating--;

    if (creating === 0) {
      pending.clear();

      for (let [requestId, request] of open)
        if (!pilotTabs.has(request.tabId)) open.delete(requestId);
    }

    updateListening();
  }
}

// Session storage forgets the tabs when Safari quits; tabs closed while the background was unloaded are dropped against the open ones.
export async function restorePilotTabs() {
  let [{ pilotTabs: saved }, tabs] = await Promise.all([
    browser.storage.session.get("pilotTabs"),
    browser.tabs.query({}),
  ]);
  let openIds = new Set(tabs.map((tab) => tab.id));

  for (let tabId of Array.isArray(saved) ? saved : [])
    if (typeof tabId === "number" && openIds.has(tabId)) pilot(tabId);

  save();
}

// A tab a pilot tab opens, such as a popup, is piloted too.
export let pilotOpened = (tab: chrome.tabs.Tab) => {
  if (tab.id !== undefined && pilotTabs.has(tab.openerTabId ?? -1))
    pilot(tab.id);
};

let notRecording = (tabId: number): Failure => ({
  ok: false,
  error: `tab ${tabId} has no request log: SafariPilot records requests only in tabs opened with tab_create and tabs they open, from when they open`,
  code: "tab_unavailable",
});

let shown = ({
  rawUrl: _rawUrl,
  requestHeaders: _requestHeaders,
  responseHeaders: _responseHeaders,
  ...entry
}: Recorded): NetworkEntry => entry;

export function listRequests(
  tabId: number,
  urlPattern: string | null,
  limit: number,
  clear: boolean,
): NetworkResult {
  let log = logs.get(tabId);

  if (!log) throw thrown(notRecording(tabId));

  let needle = urlPattern?.toLowerCase() ?? "";
  let matching = log.entries.filter((entry) =>
    entry.url.toLowerCase().includes(needle),
  );
  let result: NetworkResult = {
    ok: true,
    entries: matching.slice(-limit).map(shown),
    matched: matching.length,
    dropped: log.dropped,
  };

  if (clear) logs.set(tabId, { entries: [], dropped: 0 });

  return result;
}

export async function requestDetail(
  send: Send,
  tabId: number,
  requestId: string,
): Promise<NetworkRequestResult> {
  let log = logs.get(tabId);

  if (!log) throw thrown(notRecording(tabId));

  let entry = log.entries.find((logged) => logged.id === requestId);

  if (!entry)
    throw thrown({
      ok: false,
      error: `tab ${tabId} has no logged request ${requestId}; read_network_requests lists the ids it keeps`,
      code: "invalid_argument",
    });

  let request = {
    ...shown(entry),
    requestHeaders: entry.requestHeaders,
    responseHeaders: entry.responseHeaders,
  };
  let answer = await send(entry.frameId, {
    op: "networkBody",
    url: entry.rawUrl,
    method: entry.method,
    time: entry.time,
  });

  if (!answer.ok)
    return {
      ok: true,
      request,
      bodies: null,
      bodyNote: `frame ${entry.frameId} did not answer: ${answer.error}`,
    };

  let { capturing, record } = answer as NetworkBodyResult;

  if (!record)
    return {
      ok: true,
      request,
      bodies: null,
      bodyNote: capturing
        ? "no body recorded: SafariPilot keeps the bodies of the newest fetch and XMLHttpRequest calls of each frame only"
        : "no body capture answered; the frame loaded before SafariPilot's extension (reload the page) or runs no scripts",
    };

  return {
    ok: true,
    request,
    bodies: {
      requestBody:
        record.requestBody === null ? null : redactBody(record.requestBody),
      responseBody:
        record.responseBody === null ? null : redactBody(record.responseBody),
      contentType: record.contentType,
      truncated: record.truncated,
      note: record.note,
    },
    bodyNote: null,
  };
}
