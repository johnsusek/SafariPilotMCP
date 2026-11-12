// The app sends a Command through the background's poll; the background answers with a CommandResponse.
// tabId null means the active tab of the last focused window.
import type { ContentRequest, ContentResponse, Rect } from "./protocol";

// windowFrame is the tab's window in screen coordinates (browser.windows.get), null when unavailable.
export type TabInfo = {
  id: number;
  windowId: number;
  active: boolean;
  url: string;
  title: string;
  windowFrame: Rect | null;
};

export type Command =
  // Forwards the request to the tab's content script and returns its ContentResponse.
  | { type: "content"; tabId: number | null; request: ContentRequest }
  | { type: "tabs" }
  // Resolves the target tab without side effects.
  | { type: "tab"; tabId: number | null }
  // Opens a tab in the last focused window; with a url, answers once it has loaded.
  | { type: "tabCreate"; url: string | null }
  // Makes the tab the active tab of its window.
  | { type: "tabSelect"; tabId: number }
  | { type: "tabClose"; tabId: number }
  // navigate and history answer once the tab has finished loading, or fail after a timeout.
  | { type: "navigate"; tabId: number | null; url: string }
  | { type: "history"; tabId: number | null; direction: "back" | "forward" }
  // Fails when the tab is not the active tab of its window; the app selects it first.
  | { type: "screenshot"; tabId: number | null };

export type TabsResult = { ok: true; tabs: TabInfo[] };
export type TabResult = { ok: true; tab: TabInfo };
export type ClosedResult = { ok: true; closed: number };
export type ScreenshotResult = { ok: true; dataUrl: string; tab: TabInfo };

export type CommandResponse =
  | ContentResponse
  | TabsResult
  | TabResult
  | ClosedResult
  | ScreenshotResult;
