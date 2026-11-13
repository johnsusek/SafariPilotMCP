// The app sends a Command through the background's poll; the background answers with a CommandResponse.
// tabId null means the active tab of the last focused window.
import type {
  ClickAction,
  ClickResult,
  ContentResponse,
  ElementInfo,
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
  | { op: "pageText"; maxChars: number }
  | { op: "scroll"; ref: RefPath | null; left: number; top: number }
  | { op: "scrollIntoView"; ref: RefPath };

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
export type PageInspectResult = Omit<InspectResult, "ref"> & { ref: RefPath };
export type PageClickResult = Omit<ClickResult, "ref"> & { ref: RefPath };
export type PageUploadResult = Omit<UploadResult, "ref"> & { ref: RefPath };
export type PageFindResult = { ok: true; matches: PageElement[] };
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
  // Opens a tab in windowId, or in a new unfocused window when it is null or closed; with a url, answers once it has loaded.
  | { type: "tabCreate"; url: string | null; windowId: number | null }
  // Makes the tab the active tab of its window.
  | { type: "tabSelect"; tabId: number }
  | { type: "tabClose"; tabId: number }
  // navigate and history answer once the tab has finished loading, or fail after a timeout.
  | { type: "navigate"; tabId: number | null; url: string }
  | { type: "history"; tabId: number | null; direction: "back" | "forward" }
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
    };

export type TabsResult = { ok: true; tabs: TabInfo[] };
export type TabResult = { ok: true; tab: TabInfo };
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

export type CommandResponse =
  | ContentResponse
  | PageEventsResult
  | PageLocateResult
  | PageInspectResult
  | PageClickResult
  | PageUploadResult
  | PageFindResult
  | PageSnapshotResult
  | PageReadResult
  | TabsResult
  | TabResult
  | ClosedResult
  | ScreenshotResult
  | FramesTree
  | JavascriptResult;
