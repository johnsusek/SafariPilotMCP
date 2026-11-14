import type { SettleResult } from "../shared/commands";
import { resolveTab, tabInfo } from "./tabs";

export let loadTimeoutMs = 15000;
// How long an address change without a load (a single-page app's pushState) gets to start one or retitle the page before it is reported.
export let addressSettleMs = 500;
let pollMs = 25;

// Listens from the call on, so a load that completes before wait() is called (or before its tab id is known) still counts.
// wait resolves false when the tab was still loading after loadTimeoutMs.
function watchLoads() {
  let completed = new Set<number>();
  let notify = (_tabId: number) => {};
  let listener = (tabId: number, change: chrome.tabs.OnUpdatedInfo) => {
    if (change.status !== "complete") return;

    completed.add(tabId);
    notify(tabId);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  browser.tabs.onUpdated.addListener(listener);
  let wait = async (tabId: number) => {
    if (completed.has(tabId)) return true;

    return await new Promise<boolean>((resolve) => {
      notify = (loadedId) => {
        if (loadedId === tabId) resolve(true);
      };
      timer = setTimeout(() => resolve(false), loadTimeoutMs);
    });
  };
  let stop = () => {
    clearTimeout(timer);
    browser.tabs.onUpdated.removeListener(listener);
  };
  return { completed, wait, stop };
}

export async function loadAfter(start: () => Promise<number>) {
  let loads = watchLoads();

  try {
    let tabId = await start();
    return { tabId, loaded: await loads.wait(tabId) };
  } finally {
    loads.stop();
  }
}

// After an action the app dispatched: a tab that starts loading within watchMs is waited for like navigate; one that only changed its address from url is read again after addressSettleMs.
export async function settle(
  tabId: number,
  url: string,
  watchMs: number,
): Promise<SettleResult> {
  let loads = watchLoads();

  try {
    let end = Date.now() + watchMs;
    let moved = false;
    let tab = await resolveTab(tabId);
    let started = () => tab.status === "loading" || loads.completed.has(tabId);

    while (!started()) {
      if (!moved && tab.url !== url) {
        moved = true;
        end = Date.now() + addressSettleMs;
      }

      if (Date.now() >= end) break;

      await new Promise((resolve) => setTimeout(resolve, pollMs));
      tab = await resolveTab(tabId);
    }

    if (!started())
      return {
        ok: true,
        tab: await tabInfo(tab),
        navigation: moved ? "sameDocument" : "none",
        loading: false,
      };

    let loaded = await loads.wait(tabId);
    return {
      ok: true,
      tab: await tabInfo(await resolveTab(tabId)),
      navigation: "load",
      loading: !loaded,
    };
  } finally {
    loads.stop();
  }
}
