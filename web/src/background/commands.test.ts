import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { accessDeadlineMs } from "./access";
import { runCommand } from "./commands";
import { addressSettleMs, loadTimeoutMs } from "./load";
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
  webRequest: Object.fromEntries(
    [
      "onBeforeRequest",
      "onSendHeaders",
      "onBeforeRedirect",
      "onCompleted",
      "onErrorOccurred",
    ].map((name) => [name, { addListener: vi.fn(), removeListener: vi.fn() }]),
  ),
  scripting: {
    executeScript: vi.fn(async () => [
      { frameId: 0, result: { ok: true, json: "2" } },
    ]),
  },
  windows: {
    get: vi.fn(async (id: number, options?: { populate?: boolean }) => ({
      ...(id === 1 ? { left: 10, top: 20, width: 800, height: 600 } : {}),
      id,
      ...(options?.populate
        ? { tabs: tabs.filter((tab) => tab.windowId === id) }
        : {}),
    })),
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
    expect(rejected).toMatchObject({ ok: false, code: "no_content_script" });
    expect((rejected as { error: string }).error).toMatch(
      /^no content script answered in tab 5 .*open the URL in a new tab/,
    );
    fake.tabs.sendMessage.mockResolvedValue(undefined);
    let silent = await run({
      type: "content",
      tabId: null,
      request: { op: "ping" },
    });
    expect(silent).toMatchObject({ ok: false, code: "no_content_script" });
    expect((silent as { error: string }).error).toMatch(
      /open the URL in a new tab/,
    );
  });

  test("the no content script failure hides credentials in the tab's URL", async () => {
    tabs[0].url = "https://u:pw@site/cb?code=4/0Ab&state=s";
    fake.tabs.sendMessage.mockResolvedValue(undefined);
    let failed = await run({
      type: "content",
      tabId: null,
      request: { op: "ping" },
    });
    expect((failed as { error: string }).error).toContain(
      "(https://[hidden]@site/cb?code=[hidden]&state=s)",
    );
  });

  test("a wait on a tab with no content script yet is pending, not failed", async () => {
    fake.tabs.sendMessage.mockRejectedValue(
      new Error("Could not establish connection"),
    );
    let result = await run({
      type: "content",
      tabId: null,
      request: { op: "waitFor", text: "Ready", selector: null },
    });
    expect(result).toMatchObject({ ok: true, match: null, url: null });
    expect((result as { pending: string }).pending).toMatch(
      /^no content script answered in tab 5/,
    );
  });

  test("screenshot fails unless the tab is active in its window", async () => {
    expect(await run({ type: "screenshot", tabId: 6 })).toEqual({
      ok: false,
      error: "tab 6 is not the active tab of its window; select it first",
      code: "tab_unavailable",
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
      code: "timed_out",
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
    tabs = tabs.filter((tab) => tab.windowId !== 1);
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
    tabs = tabs.filter((tab) => tab.windowId !== 1);
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

  test("tabCreate never reuses a stored window holding the user's tabs", async () => {
    stored.pilotWindow = 1;
    fake.windows.create.mockImplementation(async () => {
      tabs.push(tab(9, 3, true));
      return { id: 3, tabs: [tabs.at(-1)!] };
    });
    await run({ type: "tabCreate", url: null });
    expect(fake.tabs.create).not.toHaveBeenCalled();
    expect(stored.pilotWindow).toBe(3);
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
      code: "invalid_argument",
    });
  });
});

describe("site access", () => {
  let refusal = new Error(
    "Invalid call to scripting.executeScript(). this extension does not have access to this tab.",
  );
  let silent = () =>
    fake.tabs.sendMessage.mockRejectedValue(
      new Error("Could not establish connection"),
    );
  let content = (request: object, tabId: number | null = 6) =>
    run({ type: "content", tabId, request });
  let probe = {
    target: { tabId: 6, frameIds: [0] },
    func: expect.any(Function),
  };

  test("a silent top frame on a refused site fails as denied, naming the site, for every page request", async () => {
    silent();
    fake.scripting.executeScript.mockRejectedValue(refusal);
    let requests = [
      {
        op: "readPage",
        filter: "all",
        maxChars: 100,
        ref: null,
        depth: null,
        viewport: false,
      },
      { op: "find", name: "Go", role: "" },
      { op: "pageText", maxChars: 100, format: "text", ref: null },
      { op: "locate", ref: "12" },
      { op: "locate", ref: "5:12" },
      { op: "inspect", ref: "12" },
      { op: "focus", ref: "12" },
      { op: "events", clear: true, arm: false, watch: "12" },
      { op: "scroll", ref: null, left: 0, top: 100 },
      { op: "scrollIntoView", ref: "12" },
      {
        op: "console",
        onlyErrors: false,
        pattern: null,
        limit: 5,
        clear: false,
      },
      { op: "upload", ref: "12", files: [] },
      { op: "waitFor", text: "Ready", selector: null },
    ];

    for (let request of requests) {
      let result = await content(request);
      expect(result, JSON.stringify(request)).toMatchObject({
        ok: false,
        code: "site_access_denied",
      });
      expect((result as { error: string }).error).toMatch(
        /^Safari has not granted SafariPilot access to https:\/\/site \(refused, or never allowed\)/,
      );
    }

    expect(fake.scripting.executeScript).toHaveBeenCalledWith(probe);
  });

  test("a silent top frame whose probe is held is the open prompt", async () => {
    vi.useFakeTimers();
    fake.tabs.sendMessage.mockResolvedValue(undefined);
    fake.scripting.executeScript.mockReturnValue(new Promise(() => {}));
    let pending = content({ op: "waitFor", text: "Ready", selector: null });
    await vi.advanceTimersByTimeAsync(accessDeadlineMs);
    let result = await pending;
    expect(result).toMatchObject({ ok: false, code: "site_access_prompt" });
    expect((result as { error: string }).error).toMatch(
      /^Safari is asking the user whether SafariPilot may use https:\/\/site and holds every call for tab 6/,
    );
  });

  test("a tab lookup Safari holds is the open prompt, for page commands and tab", async () => {
    vi.useFakeTimers();
    fake.tabs.get.mockReturnValue(new Promise(() => {}));

    for (let command of [
      { type: "tab", tabId: 6 },
      { type: "content", tabId: 6, request: { op: "ping" } },
      { type: "javascript", tabId: 6, code: "1", frame: null },
      { type: "screenshot", tabId: 6 },
      { type: "frames", tabId: 6 },
    ]) {
      let pending = run(command);
      await vi.advanceTimersByTimeAsync(accessDeadlineMs);
      expect(await pending, command.type).toMatchObject({
        ok: false,
        code: "site_access_prompt",
        error: expect.stringMatching(/may use the site in tab 6 /),
      });
    }
  });

  test("a granted site with no content script keeps the new-tab advice", async () => {
    silent();
    let result = await content({ op: "ping" });
    expect(fake.scripting.executeScript).toHaveBeenCalledWith(probe);
    expect(result).toMatchObject({ ok: false, code: "no_content_script" });
  });

  test("a probe failing some other way keeps the content failure", async () => {
    silent();
    fake.scripting.executeScript.mockRejectedValue(
      new Error("could not execute script on this tab"),
    );
    expect(await content({ op: "ping" })).toMatchObject({
      ok: false,
      code: "no_content_script",
    });
  });

  test("a silent iframe is not probed", async () => {
    let viewport = {
      innerWidth: 800,
      innerHeight: 600,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      visualScale: 1,
      visualOffsetLeft: 0,
      visualOffsetTop: 0,
    };
    let box = { left: 0, top: 0, width: 300, height: 200 };
    fake.tabs.sendMessage.mockImplementation(
      async (_tab: number, request: { op: string }, { frameId }) => {
        if (frameId !== 0) return undefined;

        if (request.op === "frames")
          return {
            ok: true,
            url: "u",
            title: "t",
            viewport,
            frames: [
              {
                ref: 5,
                frameId: 41,
                src: "https://other.test/",
                sandbox: null,
                box,
                clip: box,
                transformed: false,
              },
            ],
          };

        return { ok: true, matches: [] };
      },
    );
    expect(await content({ op: "find", name: "Go", role: "" })).toEqual({
      ok: true,
      matches: [],
    });
    expect(fake.scripting.executeScript).not.toHaveBeenCalled();
  });

  test("javascript and screenshot on a refused site fail as denied", async () => {
    fake.scripting.executeScript.mockRejectedValue(refusal);
    expect(
      await run({ type: "javascript", tabId: 6, code: "1", frame: null }),
    ).toMatchObject({ ok: false, code: "site_access_denied" });
    fake.tabs.captureVisibleTab.mockRejectedValue(
      new Error(
        "Invalid call to tabs.captureVisibleTab(). either the 'activeTab' permission or granted host permissions for the current website are required.",
      ),
    );
    let shot = await run({ type: "screenshot", tabId: 7 });
    expect(shot).toMatchObject({ ok: false, code: "site_access_denied" });
    expect((shot as { error: string }).error).toContain("https://site");
  });

  test("navigate to a site Safari is asking about reports the load with the access prompt", async () => {
    vi.useFakeTimers();
    fake.tabs.update.mockImplementation(async () => {
      fake.tabs.get.mockReturnValue(new Promise(() => {}));
      setTimeout(() => fireComplete(6), 0);
    });
    let pending = run({
      type: "navigate",
      tabId: 6,
      url: "https://new.test/a",
    });
    await vi.advanceTimersByTimeAsync(accessDeadlineMs + 1);
    expect(await pending).toMatchObject({
      ok: true,
      tab: { id: 6, url: "https://new.test/a", title: "", windowFrame: frame },
      loading: false,
      access: { ok: false, code: "site_access_prompt" },
    });
  });

  test("tabCreate keeps its tab when Safari holds it behind the prompt", async () => {
    vi.useFakeTimers();
    stored.pilotWindow = 1;
    tabs = tabs.filter((tab) => tab.windowId !== 1);
    fake.tabs.create.mockImplementation(async () => {
      fake.tabs.get.mockReturnValue(new Promise(() => {}));
      setTimeout(() => fireComplete(8), 0);
      return { ...tab(8, 1, true), url: "" };
    });
    let pending = run({ type: "tabCreate", url: "https://new.test/" });
    await vi.advanceTimersByTimeAsync(accessDeadlineMs + 1);
    expect(await pending).toMatchObject({
      ok: true,
      tab: { id: 8, windowId: 1, url: "https://new.test/" },
      access: { code: "site_access_prompt" },
    });
  });

  test("navigate on a granted site reports no access, and listing tabs never probes", async () => {
    fake.tabs.update.mockImplementation(async () => {
      setTimeout(() => fireComplete(6), 0);
    });
    let result = await run({ type: "navigate", tabId: 6, url: "https://next" });
    expect(result).not.toHaveProperty("access");
    await run({ type: "tabs" });
    expect(fake.scripting.executeScript).not.toHaveBeenCalled();
  });
});

describe("settle", () => {
  let settle = (watchMs = 150) =>
    run({ type: "settle", tabId: 6, url: "https://site/6", watchMs });
  let later = (ms: number, change: () => void) => setTimeout(change, ms);
  let answered = false;
  let tracked = (pending: ReturnType<typeof run>) =>
    pending.then((result) => {
      answered = true;
      return result;
    });

  beforeEach(() => {
    vi.useFakeTimers();
    tabs[1].status = "complete";
    answered = false;
  });

  test("a tab that starts no load answers after the watch window", async () => {
    let pending = tracked(settle());
    await vi.advanceTimersByTimeAsync(140);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({
      ok: true,
      tab: { id: 6, url: "https://site/6" },
      navigation: "none",
      loading: false,
    });
    expect(listeners.size).toBe(0);
  });

  test("a load that starts within the window is waited for and names where the tab landed", async () => {
    later(60, () => {
      tabs[1].status = "loading";
    });
    later(2000, () => {
      Object.assign(tabs[1], {
        status: "complete",
        url: "https://next",
        title: "Next",
      });
      fireComplete(6);
    });
    let pending = tracked(settle());
    await vi.advanceTimersByTimeAsync(1999);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({
      ok: true,
      tab: { id: 6, url: "https://next", title: "Next" },
      navigation: "load",
      loading: false,
    });
    expect(listeners.size).toBe(0);
  });

  test("a load still going at the timeout answers as loading", async () => {
    tabs[1].status = "loading";
    let pending = settle(0);
    await vi.advanceTimersByTimeAsync(loadTimeoutMs);
    expect(await pending).toMatchObject({
      navigation: "load",
      loading: true,
    });
  });

  test("a load that completed before the first look still counts", async () => {
    later(10, () => fireComplete(6));
    let pending = settle();
    await vi.advanceTimersByTimeAsync(150);
    expect(await pending).toMatchObject({ navigation: "load", loading: false });
  });

  test("an address change without a load answers after the settle, not the load timeout", async () => {
    later(40, () => {
      Object.assign(tabs[1], { url: "https://site/6#/route", title: "Route" });
    });
    let pending = tracked(settle());
    await vi.advanceTimersByTimeAsync(40 + addressSettleMs - 30);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toMatchObject({
      tab: { url: "https://site/6#/route", title: "Route" },
      navigation: "sameDocument",
      loading: false,
    });
  });

  test("a load starting after the window, or another tab loading, is not waited for", async () => {
    later(200, () => {
      tabs[1].status = "loading";
    });
    later(30, () => fireComplete(7));
    let pending = settle();
    await vi.advanceTimersByTimeAsync(175);
    expect(await pending).toMatchObject({ navigation: "none" });
  });
});
