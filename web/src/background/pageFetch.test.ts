import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PageFetchRequest } from "../shared/commands";
import type { ContentRequest, PageFetchAnswer } from "../shared/protocol";
import { failureFrom } from "./frames";

type Listener = (details: object) => void;

let listeners: Record<string, Listener | null>;
let network: typeof import("./network");
let pageFetch: typeof import("./pageFetch");

let fire = (name: string, details: object) =>
  listeners[name]?.({
    frameId: 0,
    method: "GET",
    type: "xmlhttprequest",
    ...details,
  });

let csrf = "csrf-secret-123";
let bearer = "Bearer raw-token-456";

// A logged request with headers the page and browser sent, as webRequest reports them.
let log = (
  requestId: string,
  url: string,
  method = "GET",
  frameId = 0,
  headers = [
    { name: "Accept", value: "application/json" },
    { name: "Authorization", value: bearer },
    { name: "X-CSRF-Token", value: csrf },
    { name: "Cookie", value: "sid=raw-cookie" },
    { name: "User-Agent", value: "Safari" },
    { name: "If-None-Match", value: '"etag"' },
    { name: "Sec-Fetch-Mode", value: "cors" },
  ],
) => {
  fire("onBeforeRequest", {
    requestId,
    tabId: 3,
    url,
    method,
    frameId,
    timeStamp: 5000,
  });
  fire("onSendHeaders", { requestId, tabId: 3, requestHeaders: headers });
};

let answer = (overrides: Partial<PageFetchAnswer> = {}): PageFetchAnswer => ({
  ok: true,
  status: 200,
  statusText: "OK",
  url: "https://a.test/api/items?page=2",
  redirected: false,
  headers: [
    { name: "content-type", value: "application/json" },
    { name: "x-session-token", value: "server-secret" },
  ],
  contentType: "application/json",
  binary: false,
  size: 0,
  body: '{"items":[{"id":1,"token":"t1"},{"id":2,"token":"t2"}],"next":"https://a.test/api?page=3&sig=abc"}',
  truncated: false,
  ...overrides,
});

let sent: { frameId: number; request: ContentRequest }[];
let reply: PageFetchAnswer | { ok: false; error: string; code: "timed_out" };
let send = async (frameId: number, request: ContentRequest) => {
  sent.push({ frameId, request });
  return reply;
};

let request = (overrides: Partial<PageFetchRequest>): PageFetchRequest => ({
  url: null,
  method: null,
  requestId: null,
  query: {},
  headers: {},
  body: null,
  pick: null,
  maxChars: 50000,
  ...overrides,
});

let pilotTab = { id: 3, url: "https://a.test/app/page" };
let run = (overrides: Partial<PageFetchRequest>, tab = pilotTab) =>
  pageFetch.runPageFetch(tab, send, request(overrides));
let failing = (overrides: Partial<PageFetchRequest>, tab = pilotTab) =>
  run(overrides, tab).then(
    () => null,
    (error) => failureFrom(error),
  );

beforeEach(async () => {
  vi.resetModules();
  listeners = {};
  let event = (name: string) => ({
    addListener: (listener: Listener) => (listeners[name] = listener),
    removeListener: () => (listeners[name] = null),
  });
  vi.stubGlobal("browser", {
    webRequest: Object.fromEntries(
      [
        "onBeforeRequest",
        "onSendHeaders",
        "onBeforeRedirect",
        "onCompleted",
        "onErrorOccurred",
      ].map((name) => [name, event(name)]),
    ),
    storage: { session: { set: async () => {} } },
    tabs: { sendMessage: async () => undefined },
  });
  network = await import("./network");
  pageFetch = await import("./pageFetch");
  await network.piloting(async () => ({ id: 3 }));
  sent = [];
  reply = answer();
});

describe("url mode", () => {
  test("resolves a relative URL against the tab and sends it from the top frame", async () => {
    let result = await run({
      url: "/api/items?page=2",
      headers: { "X-Requested-With": "fetch" },
    });
    expect(sent).toEqual([
      {
        frameId: 0,
        request: {
          op: "pageFetch",
          url: "https://a.test/api/items?page=2",
          method: "GET",
          headers: [{ name: "X-Requested-With", value: "fetch" }],
          body: null,
          replay: null,
          timeoutMs: pageFetch.pageFetchTimeoutMs,
        },
      },
    ]);
    expect(result).toMatchObject({
      method: "GET",
      url: "https://a.test/api/items?page=2",
      replayOf: null,
      sentHeaders: ["X-Requested-With"],
      status: 200,
    });
  });

  test("refuses forbidden headers the caller passes", async () => {
    for (let name of [
      "Cookie",
      "origin",
      "Referer",
      "Host",
      "Content-Length",
      "Sec-Fetch-Site",
      "Proxy-Authorization",
    ])
      expect(
        await failing({ url: "/x", headers: { [name]: "v" } }),
        name,
      ).toMatchObject({
        code: "invalid_argument",
        error: expect.stringContaining(`${name} cannot be set`),
      });

    expect(sent).toEqual([]);
  });

  test("refuses malformed header names and values", async () => {
    expect(
      (await failing({ url: "/x", headers: { "Bad Name": "v" } }))?.error,
    ).toMatch(/not a valid HTTP token/);
    expect(
      (await failing({ url: "/x", headers: { A: "line\nbreak" } }))?.error,
    ).toMatch(/line break/);
    expect(
      (await failing({ url: "/x", headers: { A: "emoji 🙂" } }))?.code,
    ).toBe("invalid_argument");
  });

  test("refuses a URL that is not one", async () => {
    expect(await failing({ url: "http://[::1" })).toMatchObject({
      code: "invalid_argument",
    });
  });
});

describe("host rule", () => {
  test("allows the tab's own origin and origins in its log", async () => {
    log("1", "https://api.b.test/v1/me");
    await run({ url: "https://a.test/other" });
    await run({ url: "https://api.b.test/v1/items" });
    expect(sent).toHaveLength(2);
  });

  test("refuses any other origin, scheme or port", async () => {
    log("1", "https://api.b.test/v1/me");

    for (let url of [
      "https://evil.test/",
      "http://a.test/",
      "https://a.test:8443/",
      "https://b.test/",
    ])
      expect(await failing({ url }), url).toMatchObject({
        code: "invalid_argument",
        error: expect.stringContaining("neither"),
      });

    expect((await failing({ url: "data:text/plain,hi" }))?.error).toBe(
      "page_fetch sends only http and https requests, not data:",
    );
    expect(sent).toEqual([]);
  });

  test("a tab without a log still reaches its own origin", async () => {
    let other = { id: 9, url: "https://c.test/" };
    await run({ url: "/a" }, other);
    expect(sent).toHaveLength(1);
    expect((await failing({ url: "https://a.test/" }, other))?.code).toBe(
      "invalid_argument",
    );
  });

  test("redacts URLs in its refusal", async () => {
    expect(
      (await failing({ url: "https://evil.test/?token=abc" }))?.error,
    ).toContain("https://evil.test/?token=[hidden]");
  });
});

describe("methods", () => {
  test("sends any method with its body", async () => {
    await run({ url: "/a", method: "head" });
    await run({ url: "/a", method: "post", body: "{}" });
    expect(sent.map(({ request }) => request)).toMatchObject([
      { method: "HEAD" },
      { method: "POST", body: "{}" },
    ]);
  });

  test("refuses a body on GET and HEAD, and methods fetch never sends", async () => {
    expect((await failing({ url: "/a", body: "x" }))?.error).toBe(
      "GET cannot carry a body; leave out body",
    );
    expect((await failing({ url: "/a", method: "TRACE" }))?.error).toBe(
      "TRACE is a method fetch never sends",
    );
    expect((await failing({ url: "/a", method: "GE T" }))?.error).toMatch(
      /not an HTTP method/,
    );
  });
});

describe("replay", () => {
  test("sends the logged request from its frame with its headers minus the browser's own", async () => {
    log("1", "https://a.test/api/items?page=1&q=x", "GET", 4);
    let result = await run({ requestId: "1" });
    expect(sent).toEqual([
      {
        frameId: 4,
        request: {
          op: "pageFetch",
          url: "https://a.test/api/items?page=1&q=x",
          method: "GET",
          headers: [
            { name: "Accept", value: "application/json" },
            { name: "Authorization", value: bearer },
            { name: "X-CSRF-Token", value: csrf },
          ],
          body: null,
          replay: {
            url: "https://a.test/api/items?page=1&q=x",
            method: "GET",
            time: 5000,
          },
          timeoutMs: pageFetch.pageFetchTimeoutMs,
        },
      },
    ]);
    expect(result).toMatchObject({
      replayOf: "1",
      frameId: 4,
      sentHeaders: ["Accept", "Authorization", "X-CSRF-Token"],
    });
  });

  test("merges query, headers and body over the logged request", async () => {
    log("1", "https://a.test/api/items?page=1&q=x&sort=new", "POST");
    await run({
      requestId: "1",
      query: { page: "2", q: null, extra: "a b" },
      headers: { accept: "text/csv", "X-CSRF-Token": null, "X-Trace": "1" },
      body: '{"n":2}',
    });
    expect(sent[0].request).toMatchObject({
      url: "https://a.test/api/items?page=2&sort=new&extra=a+b",
      method: "POST",
      headers: [
        { name: "Authorization", value: bearer },
        { name: "accept", value: "text/csv" },
        { name: "X-Trace", value: "1" },
      ],
      body: '{"n":2}',
    });
  });

  test("keeps the logged URL as written when no query is given", async () => {
    log("1", "https://a.test/api?x=a%20b&y=1,2");
    await run({ requestId: "1" });
    expect(sent[0].request).toMatchObject({
      url: "https://a.test/api?x=a%20b&y=1,2",
    });
  });

  test("fails loudly for a request no longer in the log", async () => {
    log("1", "https://a.test/api");
    network.listRequests(3, null, 50, true);
    expect(await failing({ requestId: "1" })).toMatchObject({
      code: "invalid_argument",
      error:
        "tab 3 has no logged request 1; read_network_requests lists the ids it keeps",
    });
    let unlogged = await failing(
      { requestId: "1" },
      {
        id: 9,
        url: "https://a.test/",
      },
    );
    expect(unlogged?.code).toBe("tab_unavailable");
  });

  test("raw header values never appear in a reply, a listing or a request's details", async () => {
    log("1", "https://a.test/api/items");
    fire("onCompleted", {
      requestId: "1",
      tabId: 3,
      timeStamp: 5100,
      statusCode: 200,
    });
    let shown = JSON.stringify([
      await run({ requestId: "1" }),
      network.listRequests(3, null, 50, false),
      await network.requestDetail(
        async () => ({ ok: true, capturing: true, record: null }),
        3,
        "1",
      ),
      await failing({
        requestId: "1",
        query: { a: "1" },
        headers: { Cookie: "x" },
      }),
    ]);

    for (let secret of [csrf, bearer, "raw-cookie"])
      expect(shown).not.toContain(secret);
  });
});

describe("reply", () => {
  test("hides secrets in the URL, headers and body", async () => {
    reply = answer({ url: "https://a.test/api?token=abc" });
    let result = await run({ url: "/api?token=abc" });
    expect(result).toMatchObject({
      url: "https://a.test/api?token=[hidden]",
      finalUrl: "https://a.test/api?token=[hidden]",
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "x-session-token", value: "[hidden]" },
      ],
      body: '{"items":[{"id":1,"token":"[hidden]"},{"id":2,"token":"[hidden]"}],"next":"https://a.test/api?page=3&sig=[hidden]"}',
      omitted: 0,
    });
  });

  test("redacts before pick, so a path cannot lift a secret out from under its name", async () => {
    expect((await run({ url: "/a", pick: "items[].token" })).body).toBe(
      '["[hidden]","[hidden]"]',
    );
    expect((await run({ url: "/a", pick: "items[].id" })).body).toBe("[1,2]");
    expect((await run({ url: "/a", pick: "next" })).body).toBe(
      '"https://a.test/api?page=3&sig=[hidden]"',
    );
  });

  test("cuts the body at maxChars and counts the rest", async () => {
    let result = await run({ url: "/a", pick: "items", maxChars: 10 });
    expect(result.body).toBe('[{"id":1,"');
    expect(result.omitted).toBe(
      '[{"id":1,"token":"[hidden]"},{"id":2,"token":"[hidden]"}]'.length - 10,
    );
  });

  test("a pick on a body that is not whole JSON fails after saying the request was sent", async () => {
    reply = answer({ contentType: "text/html", body: "<html>" });
    expect(await failing({ url: "/a", pick: "a" })).toMatchObject({
      code: "invalid_argument",
      error:
        "GET https://a.test/a was sent and answered 200 OK, but pick needs a JSON body and the text/html body is not JSON",
    });
    reply = answer({ body: '{"a":', truncated: true, size: 100000 });
    expect((await failing({ url: "/a", pick: "a" }))?.error).toContain(
      "cut at 100000 characters",
    );
    reply = answer({
      body: null,
      binary: true,
      size: 2048,
      contentType: "image/png",
    });
    expect((await failing({ url: "/a", pick: "a" }))?.error).toContain(
      "as 2048 bytes of image/png",
    );
    reply = answer();
    expect((await failing({ url: "/a", pick: "missing" }))?.error).toBe(
      "GET https://a.test/a was sent and answered 200 OK, but pick: the body has no key missing (keys: items, next)",
    );
  });

  test("a bad pick path fails before anything is sent", async () => {
    expect((await failing({ url: "/a", pick: "a[" }))?.code).toBe(
      "invalid_argument",
    );
    expect(sent).toEqual([]);
  });

  test("a page failure keeps its code and names the request", async () => {
    reply = {
      ok: false,
      error: "no whole response within 10 s, so the request was aborted",
      code: "timed_out",
    };
    expect(await failing({ url: "/slow?sig=1" })).toMatchObject({
      code: "timed_out",
      error:
        "GET https://a.test/slow?sig=[hidden]: no whole response within 10 s, so the request was aborted",
    });
  });
});
