// The app sends a Command through the background's poll; the background answers with a CommandResponse.
// tabId null means the active tab of the last focused window.
import type {
  ClickAction,
  ClickResult,
  ConsoleEntry,
  ContentResponse,
  ElementInfo,
  Failure,
  FocusResult,
  FrameEntry,
  InspectResult,
  LocateResult,
  LoggedEvent,
  Modifier,
  Rect,
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
  | { op: "setColor"; ref: RefPath; value: string }
  | { op: "focus"; ref: RefPath }
  | {
      op: "syntheticClick";
      ref: RefPath;
      action: ClickAction;
      modifiers: Modifier[];
    }
  | { op: "upload"; ref: RefPath; files: UploadFile[] }
  | {
      op: "readPage";
      filter: "interactive" | "all";
      maxChars: number;
      ref: RefPath | null;
      depth: number | null;
    }
  | { op: "find"; name: string; role: string }
  | { op: "waitFor"; text: string | null; selector: string | null }
  | { op: "pageText"; maxChars: number }
  | { op: "scroll"; ref: RefPath | null; left: number; top: number }
  | { op: "scrollIntoView"; ref: RefPath }
  | {
      op: "console";
      onlyErrors: boolean;
      pattern: string | null;
      limit: number;
      clear: boolean;
    };

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
export type PageUploadResult = Omit<UploadResult, "ref"> & { ref: RefPath };
export type PageFocusResult = Omit<FocusResult, "ref"> & { ref: RefPath };
export type PageFindResult = { ok: true; matches: PageElement[] };
// The first match over the top frame, then each reached frame in document order; pending says why the page could not be read yet (no content script, mid-navigation), and url and title are then null.
export type PageWaitResult = {
  ok: true;
  url: string | null;
  title: string | null;
  match: (PageElement & { text: string }) | null;
  pending: string | null;
};
export type PageSnapshotResult = {
  ok: true;
  url: string;
  title: string;
  viewport: Viewport;
  elements: PageElement[];
};
export type PageReadResult = {
  ok: true;
  url: string;
  title: string;
  viewport: Viewport;
  text: string;
  truncated: boolean;
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
};

export type Command =
  // Runs the request against the tab's frames.
  | { type: "content"; tabId: number | null; request: PageRequest }
  | { type: "tabs" }
  // Resolves the target tab without side effects.
  | { type: "tab"; tabId: number | null }
  // Opens a tab in the pilot window, or in a new unfocused one when it is closed; with a url, answers once it has loaded, or as loading after a timeout.
  | { type: "tabCreate"; url: string | null }
  // Makes the tab the active tab of its window.
  | { type: "tabSelect"; tabId: number }
  | { type: "tabClose"; tabId: number }
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
  | { type: "networkRequest"; tabId: number | null; requestId: string };

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

export type CommandResponse =
  | ContentResponse
  | PageEventsResult
  | PageConsoleResult
  | PageLocateResult
  | PageInspectResult
  | PageClickResult
  | PageUploadResult
  | PageFocusResult
  | PageFindResult
  | PageWaitResult
  | PageSnapshotResult
  | PageReadResult
  | TabsResult
  | TabResult
  | SettleResult
  | ClosedResult
  | ScreenshotResult
  | FramesTree
  | JavascriptResult
  | NetworkResult
  | NetworkRequestResult;
