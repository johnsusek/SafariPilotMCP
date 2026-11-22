// The app sends a Command through the background's poll; the background answers with a CommandResponse.
// tabId null means the active tab of the last focused window.
import type {
  ClickAction,
  ClickResult,
  DragResult,
  ConsoleEntry,
  ContentResponse,
  ElementInfo,
  Failure,
  FocusResult,
  KeyPress,
  FrameEntry,
  InspectResult,
  LocateResult,
  LoggedEvent,
  Modifier,
  Rect,
  TextFormat,
  UploadFile,
  UploadResult,
  Viewport,
} from "./protocol";

// A ref anywhere in the page: the refs of the iframes leading to the element's frame, then its ref in that frame, joined by colons.
// "12" is a top-frame ref and "5:12" ref 12 in the frame of iframe 5; at most 3 frames deep.
export type RefPath = string;

// What the app asks of a page; the background routes each ref to the frame that owns it and fans reads out over every frame.
export type PageRequest =
  | { op: "ping" }
  | { op: "snapshot" }
  | { op: "locate"; ref: RefPath }
  // watch is the ref an action targets: its frame is always read, and its events carry onTarget.
  | { op: "events"; clear: boolean; arm: boolean; watch: RefPath | null }
  | { op: "inspect"; ref: RefPath }
  | { op: "setValue"; ref: RefPath; value: string }
  | { op: "selectOption"; ref: RefPath; index: number }
  | { op: "announceInput"; ref: RefPath }
  // ref null presses at whatever has focus in the top frame.
  | { op: "keys"; ref: RefPath | null; presses: KeyPress[] }
  | { op: "focus"; ref: RefPath }
  | {
      op: "syntheticClick";
      ref: RefPath;
      action: ClickAction;
      modifiers: Modifier[];
    }
  | { op: "drag"; ref: RefPath; to: RefPath }
  | { op: "upload"; ref: RefPath; files: UploadFile[] }
  // viewport keeps only what shows in the view, in every frame read.
  | {
      op: "readPage";
      filter: "interactive" | "all";
      maxChars: number;
      ref: RefPath | null;
      depth: number | null;
      viewport: boolean;
    }
  | { op: "find"; name: string; role: string }
  // The one element an action names by name and role instead of a ref.
  | { op: "target"; name: string; role: string }
  | { op: "waitFor"; text: string | null; selector: string | null }
  // ref limits the text to that element and the frames inside it.
  | {
      op: "pageText";
      maxChars: number;
      format: TextFormat;
      ref: RefPath | null;
    }
  | { op: "scroll"; ref: RefPath | null; left: number; top: number }
  | { op: "scrollIntoView"; ref: RefPath }
  | {
      op: "console";
      onlyErrors: boolean;
      pattern: string | null;
      limit: number;
      clear: boolean;
    }
  // Before an action on ref (or on the focused element when null): the top frame and ref's frame keep their rendered trees and watch for changes.
  | { op: "diffStart"; ref: RefPath | null }
  // After it: what those frames changed, top frame first, waiting up to waitMs for them to settle, cut at maxChars.
  | { op: "diff"; ref: RefPath | null; waitMs: number; maxChars: number };

// Page-wide results: refs are paths and rects are in top-frame CSS px.
export type PageElement = Omit<ElementInfo, "ref"> & { ref: RefPath };
// frame is the path of the frame that logged the event, "" for the top one.
export type PageEvent = Omit<LoggedEvent, "ref"> & {
  ref: RefPath | null;
  frame: RefPath;
};
// sandboxed: the element's frame is sandboxed without allow-scripts, so the page's own listeners, which would confirm a click or key, never run.
export type PageLocateResult = Omit<LocateResult, "ref" | "candidates"> & {
  ref: RefPath;
  sandboxed: boolean;
};
// origin is the top frame's performance.timeOrigin and origins every answering frame's, keyed by frame path; busy lists frames that did not answer in time, which are not gone.
export type PageEventsResult = {
  ok: true;
  events: PageEvent[];
  origin: number;
  origins: Record<RefPath, number>;
  busy: RefPath[];
};
// Console messages from every frame read, oldest first, each tagged with its frame path ("" for the top one). matched counts matches across frames before limit,
// dropped is keyed by frame path, and unread lists frames whose console could not be read, with why.
export type PageConsoleEntry = ConsoleEntry & { frame: RefPath };
export type PageConsoleResult = {
  ok: true;
  entries: PageConsoleEntry[];
  matched: number;
  dropped: Record<RefPath, number>;
  unread: { path: RefPath; label: string; reason: string }[];
};
export type PageInspectResult = Omit<InspectResult, "ref"> & { ref: RefPath };
export type PageClickResult = Omit<ClickResult, "ref"> & { ref: RefPath };
export type PageDragResult = Omit<DragResult, "ref" | "to"> & {
  ref: RefPath;
  to: RefPath;
};
export type PageUploadResult = Omit<UploadResult, "ref"> & { ref: RefPath };
export type PageFocusResult = Omit<FocusResult, "ref"> & { ref: RefPath };
export type PageFindResult = { ok: true; matches: PageElement[] };
// The only exact match over every frame find reads, else the only match, else null. matched and exact count every frame's matches; candidates are the first 20,
// exact ones first, each group on-screen first, when match is null and something matched.
export type PageTargetElement = PageElement & { exact: boolean };
export type PageTargetResult = {
  ok: true;
  match: PageTargetElement | null;
  matched: number;
  exact: number;
  candidates: PageTargetElement[];
};
// The first match over the top frame, then each reached frame in document order; pending says why the page could not be read yet (no content script, mid-navigation), and url and title are then null.
export type PageWaitResult = {
  ok: true;
  url: string | null;
  title: string | null;
  match: (PageElement & { text: string }) | null;
  pending: string | null;
};
// The diff of the top frame and the acted ref's frame. replaced is the path of a frame ("" for the top one) whose document is not the one diffStart saw,
// which leaves every other field empty; omitted counts the change lines cut at maxChars; untracked lists frames whose fetch and XMLHttpRequest calls were not waited for,
// pending counts those still unfinished, and settled says every frame was still with nothing pending when its wait ended.
export type PageDiffResult = {
  ok: true;
  replaced: RefPath | null;
  tooLarge: boolean;
  lines: string[];
  added: number;
  changed: number;
  removed: number;
  omitted: number;
  untracked: RefPath[];
  pending: number;
  settled: boolean;
};
export type PageSnapshotResult = {
  ok: true;
  url: string;
  title: string;
  viewport: Viewport;
  elements: PageElement[];
};
// above and below are the top read frame's, as in ReadPageResult.
export type PageReadResult = {
  ok: true;
  url: string;
  title: string;
  viewport: Viewport;
  text: string;
  truncated: boolean;
  above: number | null;
  below: number | null;
};

// windowFrame is the tab's window in screen coordinates (browser.windows.get), null when unavailable.
export type TabInfo = {
  id: number;
  windowId: number;
  active: boolean;
  url: string;
  title: string;
  windowFrame: Rect | null;
  openerId: number | null;
  // Opened by tabCreate or by such a tab; the app closes it once no live session owns it.
  pilot: boolean;
};

export type Command =
  // Runs the request against the tab's frames.
  | { type: "content"; tabId: number | null; request: PageRequest }
  | { type: "tabs" }
  // Resolves the target tab without side effects.
  | { type: "tab"; tabId: number | null }
  // Opens a background tab in the session's window, or a new unfocused window when it has none; with a url, answers once it has loaded, or as loading after a timeout.
  // own lists the session's other tabs, the only ones the tab's window may hold. safariFrontmost says Safari is the front app, where a new window has to be put back behind the one the user is in.
  | {
      type: "tabCreate";
      url: string | null;
      safariFrontmost: boolean;
      windowId: number | null;
      own: number[];
    }
  // Makes the tab the active tab of its window.
  | { type: "tabSelect"; tabId: number }
  | { type: "tabClose"; tabId: number }
  // Closes each tab still open, for sessions that ended.
  | { type: "closeTabs"; tabIds: number[] }
  // navigate and history answer once the tab has finished loading, or fail after a timeout.
  // settle follows an action the app dispatched: it watches the tab for watchMs for a load to start and waits for it, or notices an address change from url without one.
  | { type: "navigate"; tabId: number | null; url: string }
  | { type: "history"; tabId: number | null; direction: "back" | "forward" }
  | { type: "settle"; tabId: number; url: string; watchMs: number }
  // Resizes the tab's window to width x height points and answers with the tab's new window frame.
  | { type: "resize"; tabId: number | null; width: number; height: number }
  // Fails when the tab is not the active tab of its window; the app selects it first.
  | { type: "screenshot"; tabId: number | null }
  // Walks the tab's frames from the top one: what each frame's content script answers and the trusted clicks and keydowns it logged since the last walk.
  | { type: "frames"; tabId: number | null }
  // Runs code in the main world of the top frame, or of the frame of iframe ref frame.
  | {
      type: "javascript";
      tabId: number | null;
      code: string;
      frame: RefPath | null;
    }
  // The newest limit requests the tab made whose URL contains urlPattern (case-insensitive), from the log webRequest keeps for tabs SafariPilot opened; clear empties it after reading.
  | {
      type: "network";
      tabId: number | null;
      urlPattern: string | null;
      limit: number;
      clear: boolean;
    }
  // One logged request with its headers and, for a fetch or XMLHttpRequest call, the bodies its frame's capture kept.
  | { type: "networkRequest"; tabId: number | null; requestId: string }
  // Sends a request from the page's main world.
  | { type: "pageFetch"; tabId: number | null; request: PageFetchRequest };

// Either url (absolute or relative to the tab's URL) with method, or requestId to replay with query parameters set; a null query or header value removes
// the logged one, and a null body in a replay sends the original call's body.
export type PageFetchRequest = {
  url: string | null;
  method: string | null;
  requestId: string | null;
  query: Record<string, string | null>;
  headers: Record<string, string | null>;
  body: string | null;
  pick: string | null;
  maxChars: number;
};

export type TabsResult = { ok: true; tabs: TabInfo[] };
// loading is set by commands that wait for a load: true when a created tab was still loading after the timeout.
// access is set when Safari held the loaded tab behind its website access prompt; tab is then as known before the load, with the address asked for.
export type TabResult = {
  ok: true;
  tab: TabInfo;
  loading?: boolean;
  access?: Failure;
};
// navigation is load when the tab started loading (loading: still loading after the timeout), sameDocument when only its address changed.
export type SettleResult = {
  ok: true;
  tab: TabInfo;
  navigation: "none" | "load" | "sameDocument";
  loading: boolean;
};
export type ClosedResult = { ok: true; closed: number };
export type ClosedTabsResult = { ok: true };
export type ScreenshotResult = { ok: true; dataUrl: string; tab: TabInfo };

export type FrameNode = {
  frameId: number;
  error: string | null;
  url: string;
  title: string;
  clicks: number;
  keydowns: number;
  frames: (FrameEntry & { frame: FrameNode | null })[];
};
export type FramesTree = { ok: true; tree: FrameNode };
// json is the code's last expression as JSON, null when JSON.stringify gives undefined (undefined, a function or a symbol).
export type JavascriptResult = { ok: true; json: string | null };

export type NetworkHeader = { name: string; value: string };
// One request from webRequest: id is SafariPilot's own, time epoch ms when it started, frameId the frame that made it (0 the top one), status null until a response,
// statusLine as the server sent it, duration ms until it completed, redirected or failed (null while pending), redirect the URL it was sent on to, error why it failed.
// URLs and header values come with secrets as [hidden].
export type NetworkEntry = {
  id: string;
  frameId: number;
  method: string;
  url: string;
  type: string;
  time: number;
  status: number | null;
  statusLine: string;
  fromCache: boolean;
  duration: number | null;
  redirect: string | null;
  error: string | null;
};
// matched counts matches before limit, dropped the oldest requests the tab's full log let go since the last clear.
export type NetworkResult = {
  ok: true;
  entries: NetworkEntry[];
  matched: number;
  dropped: number;
};
// Headers are null when webRequest gave none (a request that failed before sending, or a response never received). bodies is null when no call
// was recorded for the request, with bodyNote saying why; secret header values, URL and body parameters come as [hidden].
export type NetworkRequestResult = {
  ok: true;
  request: NetworkEntry & {
    requestHeaders: NetworkHeader[] | null;
    responseHeaders: NetworkHeader[] | null;
  };
  bodies: {
    requestBody: string | null;
    responseBody: string | null;
    contentType: string;
    truncated: boolean;
    note: string | null;
  } | null;
  bodyNote: string | null;
};
// A page_fetch reply with secrets hidden: url is what was sent and finalUrl where redirects ended; replayOf is the replayed request's id and sentHeaders the
// header names sent, never values. size is the body's length as read, in characters for text and bytes when binary; body is the text after pick and the
// max_chars cut (omitted counts the characters cut), null when binary or empty; truncated says the text was cut at the capture's limit as it was read.
export type PageFetchResult = {
  ok: true;
  method: string;
  url: string;
  frameId: number;
  replayOf: string | null;
  sentHeaders: string[];
  status: number;
  statusText: string;
  finalUrl: string;
  redirected: boolean;
  headers: NetworkHeader[];
  contentType: string;
  binary: boolean;
  size: number;
  truncated: boolean;
  pick: string | null;
  body: string | null;
  omitted: number;
};

export type CommandResponse =
  | ContentResponse
  | PageEventsResult
  | PageConsoleResult
  | PageLocateResult
  | PageInspectResult
  | PageClickResult
  | PageDragResult
  | PageUploadResult
  | PageFocusResult
  | PageFindResult
  | PageTargetResult
  | PageWaitResult
  | PageSnapshotResult
  | PageDiffResult
  | PageReadResult
  | TabsResult
  | TabResult
  | SettleResult
  | ClosedResult
  | ClosedTabsResult
  | ScreenshotResult
  | FramesTree
  | JavascriptResult
  | NetworkResult
  | NetworkRequestResult
  | PageFetchResult;
