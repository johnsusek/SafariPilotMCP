export let loadTimeoutMs = 15000;

// Listens before start() runs, so a load that completes before start() resolves (or before its tab id is known) still counts.
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

    if (completed.has(tabId)) return tabId;

    await new Promise<void>((resolve, reject) => {
      notify = (loadedId) => {
        if (loadedId === tabId) resolve();
      };
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `tab ${tabId} did not finish loading within ${loadTimeoutMs / 1000} s`,
            ),
          ),
        loadTimeoutMs,
      );
    });
    return tabId;
  } finally {
    clearTimeout(timer);
    browser.tabs.onUpdated.removeListener(listener);
  }
}
