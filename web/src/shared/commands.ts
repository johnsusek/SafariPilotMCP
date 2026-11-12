// The app sends a Command through the background's poll; the background answers with a CommandResponse.
// tabId null means the active tab of the last focused window.
import type {
  ContentRequest,
  ContentResponse,
  FrameEntry,
  Rect,
} from "./protocol";

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
  // Forwards the request to the tab's content script and returns its ContentResponse.
  | { type: "content"; tabId: number | null; request: ContentRequest }
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
  | { type: "frames"; tabId: number | null };

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

export type CommandResponse =
  | ContentResponse
  | TabsResult
  | TabResult
  | ClosedResult
  | ScreenshotResult
  | FramesTree;
