import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runCommand } from "./commands";
import { loadTimeoutMs } from "./load";
import { resolveTab } from "./tabs";

type Listener = (tabId: number, change: { status?: string }) => void;

let tabs: chrome.tabs.Tab[];
let listeners: Set<Listener>;
let fireComplete = (tabId: number) => {
  for (let listener of listeners) listener(tabId, { status: "complete" });
};

let tab = (id: number, windowId: number, active: boolean) =>
  ({
    id,
    windowId,
    active,
    url: `https://site/${id}`,
    title: `T${id}`,
  }) as chrome.tabs.Tab;

let stored: Record<string, unknown>;

let fakeBrowser = () => ({
  storage: {
    session: {
      get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(stored, items);
      }),
    },
  },
  tabs: {
    query: vi.fn(async (filter: { active?: boolean }) =>
      filter.active
        ? tabs.filter((each) => each.active && each.windowId === 1)
        : tabs,
    ),
    get: vi.fn(async (id: number) => {
      let found = tabs.find((each) => each.id === id);

      if (!found) throw new Error("Invalid tab ID");

      return found;
    }),
    sendMessage: vi.fn(),
    update: vi.fn(async () => {}),
    create: vi.fn(),
    remove: vi.fn(async () => {}),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    captureVisibleTab: vi.fn(async () => "data:image/png;base64,AA"),
    onUpdated: {
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
    },
  },
  scripting: {
    executeScript: vi.fn(async () => [
      { frameId: 0, result: { ok: true, json: "2" } },
    ]),
  },
  windows: {
    get: vi.fn(async (id: number) =>
      id === 1 ? { id, left: 10, top: 20, width: 800, height: 600 } : { id },
    ),
    getAll: vi.fn(async () => [
      { id: 1, left: 10, top: 20, width: 800, height: 600 },
      { id: 2 },
    ]),
    create: vi.fn(
      async (): Promise<{ id: number; tabs: chrome.tabs.Tab[] }> => ({
        id: 3,
        tabs: [],
      }),
    ),
  },
});

let fake: ReturnType<typeof fakeBrowser>;
let frame = { left: 10, top: 20, width: 800, height: 600 };

beforeEach(() => {
  tabs = [tab(5, 1, true), tab(6, 1, false), tab(7, 2, true)];
  listeners = new Set();
  stored = {};
  fake = fakeBrowser();
  vi.stubGlobal("browser", fake);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

let run = (command: object) =>
  runCommand({ id: "c1", ...command } as Parameters<typeof runCommand>[0]);

describe("resolveTab", () => {
  test("null is the active tab of the last focused window", async () => {
    expect((await resolveTab(null)).id).toBe(5);
    expect(fake.tabs.query).toHaveBeenCalledWith({
      active: true,
      lastFocusedWindow: true,
    });
  });

  test("unknown ids fail clearly", async () => {
    await expect(resolveTab(99)).rejects.toThrow("no tab with id 99");
  });
});

describe("runCommand", () => {
  test("tabs carry their window frame, null when the window has none", async () => {
    let result = await run({ type: "tabs" });
    expect(result).toMatchObject({
      ok: true,
      tabs: [
        { id: 5, windowFrame: frame },
        { id: 6, windowFrame: frame },
        { id: 7, windowFrame: null },
      ],
    });
  });

  test("content forwards to the resolved tab", async () => {
    fake.tabs.sendMessage.mockResolvedValue({ ok: true, url: "u", title: "t" });
    let result = await run({
      type: "content",
      tabId: 6,
      request: { op: "ping" },
    });
    expect(fake.tabs.sendMessage).toHaveBeenCalledWith(
      6,
      { op: "ping" },
      { frameId: 0 },
    );
    expect(result).toEqual({ ok: true, url: "u", title: "t" });
  });

  test("content without a content script asks for a new tab", async () => {
    fake.tabs.sendMessage.mockRejectedValue(
      new Error("Could not establish connection"),
    );
    let rejected = await run({
      type: "content",
      tabId: null,
      request: { op: "ping" },
    });
    expect(rejected).toMatchObject({ ok: false });
    expect((rejected as { error: string }).error).toMatch(
      /^no content script answered in tab 5 .*open the URL in a new tab/,
    );
    fake.tabs.sendMessage.mockResolvedValue(undefined);
    let silent = await run({
      type: "content",
      tabId: null,
      request: { op: "ping" },
    });
    expect((silent as { error: string }).error).toMatch(
      /open the URL in a new tab/,
    );
  });

  test("screenshot fails unless the tab is active in its window", async () => {
    expect(await run({ type: "screenshot", tabId: 6 })).toEqual({
      ok: false,
      error: "tab 6 is not the active tab of its window; select it first",
    });
    let result = await run({ type: "screenshot", tabId: 7 });
    expect(fake.tabs.captureVisibleTab).toHaveBeenCalledWith(2, {
      format: "png",
    });
    expect(result).toMatchObject({
      ok: true,
      dataUrl: "data:image/png;base64,AA",
      tab: { id: 7 },
    });
  });

  test("navigate answers after the tab completes loading", async () => {
    fake.tabs.update.mockImplementation(async () => {
      setTimeout(() => fireComplete(6), 0);
    });
    let result = await run({ type: "navigate", tabId: 6, url: "https://next" });
    expect(fake.tabs.update).toHaveBeenCalledWith(6, { url: "https://next" });
    expect(result).toMatchObject({ ok: true, tab: { id: 6 } });
    expect(listeners.size).toBe(0);
  });

  test("a load that completes before the call returns still counts", async () => {
    fake.tabs.goBack.mockImplementation(async () => fireComplete(5));
    let result = await run({ type: "history", tabId: null, direction: "back" });
    expect(result).toMatchObject({ ok: true, tab: { id: 5 } });
  });

  test("navigate fails after the load timeout", async () => {
    vi.useFakeTimers();
    let pending = run({ type: "navigate", tabId: 6, url: "https://slow" });
    await vi.advanceTimersByTimeAsync(loadTimeoutMs);
    expect(await pending).toEqual({
      ok: false,
      error: "navigate failed: tab 6 did not finish loading within 15 s",
    });
    expect(listeners.size).toBe(0);
  });

  test("other tabs finishing do not end the wait", async () => {
    vi.useFakeTimers();
    fake.tabs.goForward.mockImplementation(async () => fireComplete(7));
    let pending = run({ type: "history", tabId: 6, direction: "forward" });
    await vi.advanceTimersByTimeAsync(loadTimeoutMs);
    expect(await pending).toMatchObject({ ok: false });
  });

  test("tabCreate with a url opens in the pilot window and waits", async () => {
    stored.pilotWindow = 1;
    fake.tabs.create.mockImplementation(async () => {
      tabs.push(tab(8, 1, true));
      fireComplete(8);
      return tabs.at(-1);
    });
    let result = await run({ type: "tabCreate", url: "https://new" });
    expect(fake.tabs.create).toHaveBeenCalledWith({
      windowId: 1,
      url: "https://new",
    });
    expect(result).toMatchObject({
      ok: true,
      tab: { id: 8, windowFrame: frame },
      loading: false,
    });
  });

  test("tabCreate answers with a tab still loading after the timeout, so its caller can own it", async () => {
    vi.useFakeTimers();
    stored.pilotWindow = 1;
    fake.tabs.create.mockImplementation(async () => {
      tabs.push(tab(8, 1, true));
      return tabs.at(-1);
    });
    let pending = run({ type: "tabCreate", url: "https://slow" });
    await vi.advanceTimersByTimeAsync(loadTimeoutMs);
    expect(await pending).toMatchObject({
      ok: true,
      tab: { id: 8 },
      loading: true,
    });
    expect(listeners.size).toBe(0);
  });

  test("tabCreate opens an unfocused pilot window when none is open, then reuses it", async () => {
    fake.windows.create.mockImplementation(async () => {
      tabs.push(tab(9, 3, true));
      return { id: 3, tabs: [tabs.at(-1)!] };
    });
    fake.tabs.create.mockImplementation(async () => {
      tabs.push(tab(10, 3, true));
      return tabs.at(-1);
    });
    let first = await run({ type: "tabCreate", url: null });
    let second = await run({ type: "tabCreate", url: null });
    expect(fake.windows.create).toHaveBeenCalledOnce();
    expect(fake.windows.create).toHaveBeenCalledWith({
      url: undefined,
      focused: false,
    });
    expect(fake.tabs.create).toHaveBeenCalledWith({
      windowId: 3,
      url: undefined,
    });
    expect(first).toMatchObject({ ok: true, tab: { id: 9, windowId: 3 } });
    expect(second).toMatchObject({ ok: true, tab: { id: 10, windowId: 3 } });
  });

  test("tabCreate replaces a closed pilot window", async () => {
    stored.pilotWindow = 4;
    fake.windows.get.mockRejectedValueOnce(new Error("No window with id: 4"));
    fake.windows.create.mockImplementation(async () => {
      tabs.push(tab(9, 3, true));
      return { id: 3, tabs: [tabs.at(-1)!] };
    });
    await run({ type: "tabCreate", url: null });
    expect(fake.tabs.create).not.toHaveBeenCalled();
    expect(stored.pilotWindow).toBe(3);
  });

  test("tabSelect activates without focusing the window, tabClose reports the id", async () => {
    await run({ type: "tabSelect", tabId: 6 });
    expect(fake.tabs.update).toHaveBeenCalledWith(6, { active: true });
    expect(await run({ type: "tabClose", tabId: 6 })).toEqual({
      ok: true,
      closed: 6,
    });
    expect(fake.tabs.remove).toHaveBeenCalledWith(6);
  });

  test("javascript runs in the resolved tab, and a syntax error fails the command", async () => {
    expect(
      await run({
        type: "javascript",
        tabId: null,
        code: "1 + 1",
        frame: null,
      }),
    ).toEqual({ ok: true, json: "2" });
    expect(fake.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 5, frameIds: [0] },
        world: "MAIN",
        args: ["return (1 + 1);"],
      }),
    );
    expect(
      await run({ type: "javascript", tabId: 6, code: "1 +", frame: null }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^javascript failed: SyntaxError: /),
    });
  });
});
