import type { TabInfo } from "../shared/commands";
import type { Rect } from "../shared/protocol";

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
});

export async function resolveTab(tabId: number | null) {
  if (tabId === null) {
    let [tab] = await browser.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });

    if (tab?.id === undefined)
      throw new Error("no active tab in the last focused window");

    return tab as Tab & { id: number };
  }

  let tab = await browser.tabs.get(tabId).catch(() => null);

  if (!tab) throw new Error(`no tab with id ${tabId}`);

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
