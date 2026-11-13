export let loadTimeoutMs = 15000;

// Listens before start() runs, so a load that completes before start() resolves (or before its tab id is known) still counts.
// loaded is false when the tab was still loading after loadTimeoutMs.
export async function loadAfter(start: () => Promise<number>) {
  let completed = new Set<number>();
  let notify = (_tabId: number) => {};
  let listener = (tabId: number, change: chrome.tabs.OnUpdatedInfo) => {
    if (change.status !== "complete") return;

    completed.add(tabId);
    notify(tabId);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  browser.tabs.onUpdated.addListener(listener);

  try {
    let tabId = await start();

    if (completed.has(tabId)) return { tabId, loaded: true };

    let loaded = await new Promise<boolean>((resolve) => {
      notify = (loadedId) => {
        if (loadedId === tabId) resolve(true);
      };
      timer = setTimeout(() => resolve(false), loadTimeoutMs);
    });
    return { tabId, loaded };
  } finally {
    clearTimeout(timer);
    browser.tabs.onUpdated.removeListener(listener);
  }
}
