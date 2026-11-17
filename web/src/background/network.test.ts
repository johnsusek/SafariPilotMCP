import { beforeEach, describe, expect, test, vi } from "vitest";
import { failureFrom } from "./frames";

type Listener = (details: object) => void;

// One webRequest event: the listener added and how often it was added and removed.
let event = () => {
  let state = {
    listener: null as Listener | null,
    added: 0,
    removed: 0,
    extra: undefined as unknown,
  };
  return {
    state,
    addListener: (listener: Listener, _filter: object, extra?: unknown) => {
      state.listener = listener;
      state.added++;
      state.extra = extra;
    },
    removeListener: () => {
      state.listener = null;
      state.removed++;
    },
  };
};

let events: Record<string, ReturnType<typeof event>>;
let stored: Record<string, unknown>;
let network: typeof import("./network");

let fire = (name: string, details: object) =>
  events[name].state.listener?.({
    frameId: 0,
    method: "GET",
    type: "xmlhttprequest",
    ...details,
  });
let request = (
  requestId: string,
  tabId: number,
  url: string,
  timeStamp = 1000,
) => fire("onBeforeRequest", { requestId, tabId, url, timeStamp });

beforeEach(async () => {
  vi.resetModules();
  events = Object.fromEntries(
    [
      "onBeforeRequest",
      "onSendHeaders",
      "onBeforeRedirect",
      "onCompleted",
      "onErrorOccurred",
    ].map((name) => [name, event()]),
  );
  stored = {};
  vi.stubGlobal("browser", {
    webRequest: events,
    tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: async () => undefined,
    },
    storage: {
      session: {
        get: async () => stored,
        set: async (values: Record<string, unknown>) =>
          Object.assign(stored, values),
      },
    },
  });
  network = await import("./network");
});

let list = (
  tabId = 3,
  urlPattern: string | null = null,
  limit = 50,
  clear = false,
) => network.listRequests(tabId, urlPattern, limit, clear);

describe("listening", () => {
  test("starts before a tab is created, keeps its first request and drops other tabs' requests", async () => {
    expect(events.onBeforeRequest.state.added).toBe(0);
    await network.piloting(async () => {
      expect(events.onBeforeRequest.state.added).toBe(1);
      request("1", 3, "https://a.test/");
      request("2", 9, "https://user.test/");
      return { id: 3 };
    });
    expect(list().entries.map((entry) => entry.url)).toEqual([
      "https://a.test/",
    ]);
    expect(() => list(9)).toThrow();
    expect(stored.pilotTabs).toEqual([3]);
    expect(events.onSendHeaders.state.extra).toEqual(["requestHeaders"]);
    expect(events.onCompleted.state.extra).toEqual(["responseHeaders"]);
  });

  test("stops when the last pilot tab closes", async () => {
    await network.piloting(async () => ({ id: 3 }));
    network.forget(3);
    expect(events.onBeforeRequest.state.removed).toBe(1);
    expect(stored.pilotTabs).toEqual([]);
  });

  test("stops after a failed creation with no pilot tab", async () => {
    await expect(
      network.piloting(async () => Promise.reject(new Error("no window"))),
    ).rejects.toThrow("no window");
    expect(events.onBeforeRequest.state.removed).toBe(1);
  });

  test("a tab a pilot tab opens is piloted", async () => {
    await network.piloting(async () => ({ id: 3 }));
    network.pilotOpened({ id: 4, openerTabId: 3 } as chrome.tabs.Tab);
    network.pilotOpened({ id: 5, openerTabId: 99 } as chrome.tabs.Tab);
    request("1", 4, "https://popup.test/");
    request("2", 5, "https://user.test/");
    expect(list(4).entries).toHaveLength(1);
    expect(() => list(5)).toThrow();
  });

  test("restores saved tabs that are still open", async () => {
    stored.pilotTabs = [7, 8];
    await network.restorePilotTabs();
    expect(stored.pilotTabs).toEqual([7]);
    expect(events.onBeforeRequest.state.added).toBe(1);
  });
});

describe("log", () => {
  beforeEach(async () => {
    await network.piloting(async () => ({ id: 3 }));
  });

  test("a completed request has its status, timing and redacted headers and URL", () => {
    request("1", 3, "https://a.test/api?q=1&token=abc", 1000);
    fire("onSendHeaders", {
      requestId: "1",
      tabId: 3,
      requestHeaders: [
        { name: "Authorization", value: "Bearer x" },
        { name: "Accept", value: "*/*" },
      ],
    });
    fire("onCompleted", {
      requestId: "1",
      tabId: 3,
      timeStamp: 1042.4,
      statusCode: 200,
      statusLine: "HTTP/1.1 200 OK",
      fromCache: true,
      responseHeaders: [{ name: "Set-Cookie", value: "sid=1" }],
    });
    let [entry] = list().entries;
    expect(entry).toEqual({
      id: "1",
      frameId: 0,
      method: "GET",
      url: "https://a.test/api?q=1&token=[hidden]",
      type: "xmlhttprequest",
      time: 1000,
      status: 200,
      statusLine: "HTTP/1.1 200 OK",
      fromCache: true,
      duration: 42,
      redirect: null,
      error: null,
    });
  });

  test("a redirect ends one entry and the next hop starts another", () => {
    request("r", 3, "http://a.test/");
    fire("onBeforeRedirect", {
      requestId: "r",
      tabId: 3,
      timeStamp: 1010,
      statusCode: 301,
      redirectUrl: "https://a.test/",
    });
    request("r", 3, "https://a.test/", 1011);
    fire("onCompleted", {
      requestId: "r",
      tabId: 3,
      timeStamp: 1020,
      statusCode: 200,
    });
    expect(
      list().entries.map(({ status, redirect }) => [status, redirect]),
    ).toEqual([
      [301, "https://a.test/"],
      [200, null],
    ]);
  });

  test("a failure keeps its error", () => {
    request("e", 3, "https://down.test/");
    fire("onErrorOccurred", {
      requestId: "e",
      tabId: 3,
      timeStamp: 1500,
      error: "A server with the specified hostname could not be found.",
    });
    expect(list().entries[0]).toMatchObject({
      status: null,
      duration: 500,
      error: "A server with the specified hostname could not be found.",
    });
  });

  test("filters by URL text, keeps the newest limit and clears", () => {
    request("1", 3, "https://a.test/API/1");
    request("2", 3, "https://a.test/img.png");
    request("3", 3, "https://a.test/api/2");
    expect(list(3, "/api/", 1)).toMatchObject({
      matched: 2,
      entries: [{ url: "https://a.test/api/2" }],
    });
    expect(list(3, null, 50, true).entries).toHaveLength(3);
    expect(list().entries).toHaveLength(0);
  });

  test("a full log lets go of its oldest requests and counts them", () => {
    for (let index = 0; index < network.maxRequests + 2; index++)
      request(String(index), 3, `https://a.test/${index}`);

    let result = list(3, null, 1);
    expect(result.dropped).toBe(2);
    expect(result.matched).toBe(network.maxRequests);
  });
});

describe("requestDetail", () => {
  beforeEach(async () => {
    await network.piloting(async () => ({ id: 3 }));
    request("1", 3, "https://a.test/login", 1000);
    fire("onCompleted", {
      requestId: "1",
      tabId: 3,
      timeStamp: 1100,
      statusCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    });
  });

  test("asks the request's frame for its bodies and redacts them", async () => {
    let send = vi.fn(async () => ({
      ok: true as const,
      capturing: true,
      record: {
        method: "GET",
        url: "https://a.test/login",
        time: 999,
        requestBody: "user=a&password=b",
        status: 200,
        contentType: "application/json",
        responseBody: '{"access_token":"t","user":{"apiKey":"k","name":"a"}}',
        truncated: false,
        note: null,
      },
    }));
    let result = await network.requestDetail(send, 3, "1");
    expect(send).toHaveBeenCalledWith(0, {
      op: "networkBody",
      url: "https://a.test/login",
      method: "GET",
      time: 1000,
    });
    expect(result.request.responseHeaders).toEqual([
      { name: "Content-Type", value: "application/json" },
    ]);
    expect(result.bodies).toEqual({
      requestBody: "user=a&password=[hidden]",
      responseBody:
        '{"access_token":"[hidden]","user":{"apiKey":"[hidden]","name":"a"}}',
      contentType: "application/json",
      truncated: false,
      note: null,
    });
  });

  test("says why there are no bodies", async () => {
    let none = async () => ({
      ok: true as const,
      capturing: true,
      record: null,
    });
    expect((await network.requestDetail(none, 3, "1")).bodyNote).toMatch(
      /^no body recorded/,
    );
    let gone = async () => ({
      ok: false as const,
      error: "no answer",
      code: "page_busy" as const,
    });
    expect((await network.requestDetail(gone, 3, "1")).bodyNote).toBe(
      "frame 0 did not answer: no answer",
    );
  });

  test("refuses an unknown id", async () => {
    let failure = await network
      .requestDetail(vi.fn(), 3, "42")
      .catch(failureFrom);
    expect(failure).toMatchObject({ code: "invalid_argument" });
  });
});
