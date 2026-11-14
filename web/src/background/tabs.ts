import type { TabInfo } from "../shared/commands";
import type { Rect } from "../shared/protocol";
import { withinAccess } from "./access";
import { thrown } from "./frames";

type Tab = chrome.tabs.Tab;
type Window = chrome.windows.Window;

export function frameOf(browserWindow: Window | undefined): Rect | null {
  let { left, top, width, height } = browserWindow ?? {};

  if (left === undefined || top === undefined) return null;

  if (width === undefined || height === undefined) return null;

  return { left, top, width, height };
}

export let infoOf = (
  tab: Tab & { id: number },
  frame: Rect | null,
): TabInfo => ({
  id: tab.id,
  windowId: tab.windowId,
  active: tab.active,
  url: tab.url ?? "",
  title: tab.title ?? "",
  windowFrame: frame,
  openerId: tab.openerTabId ?? null,
});

// Fails as Safari's website access prompt when the lookup is held past the access deadline.
export async function resolveTab(tabId: number | null) {
  if (tabId === null) {
    let [tab] = await withinAccess(
      browser.tabs.query({ active: true, lastFocusedWindow: true }),
      null,
    );

    if (tab?.id === undefined)
      throw thrown({
        ok: false,
        error: "no active tab in the last focused window",
        code: "tab_unavailable",
      });

    return tab as Tab & { id: number };
  }

  let tab = await withinAccess(
    browser.tabs.get(tabId).catch(() => null),
    tabId,
  );

  if (!tab)
    throw thrown({
      ok: false,
      error: `no tab with id ${tabId}`,
      code: "tab_unavailable",
    });

  return tab as Tab & { id: number };
}

export async function tabInfo(tab: Tab & { id: number }) {
  let browserWindow = await browser.windows
    .get(tab.windowId)
    .catch(() => undefined);
  return infoOf(tab, frameOf(browserWindow));
}

export async function allTabs() {
  let [tabs, windows] = await Promise.all([
    browser.tabs.query({}),
    browser.windows.getAll(),
  ]);
  let frames = new Map(
    windows.map((browserWindow) => [browserWindow.id, frameOf(browserWindow)]),
  );
  return tabs
    .filter((tab): tab is Tab & { id: number } => tab.id !== undefined)
    .map((tab) => infoOf(tab, frames.get(tab.windowId) ?? null));
}
