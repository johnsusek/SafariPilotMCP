// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  fetchAnswerEvent,
  fetchEvent,
  installNetworkCapture,
  maxBody,
} from "../main/network";
import type { ContentRequest } from "../shared/protocol";
import { installPageFetchReader, pageFetch } from "./pageFetch";

type FetchRequest = Extract<ContentRequest, { op: "pageFetch" }>;

let origin = location.href;
let at = (path: string) => new URL(path, origin).href;
let request = (overrides: Partial<FetchRequest> = {}): FetchRequest => ({
  op: "pageFetch",
  url: at("/api/items"),
  method: "GET",
  headers: [],
  body: null,
  replay: null,
  timeoutMs: 10000,
  ...overrides,
});

// The browser's fetch as the capture keeps it: it answers by path.
let browserFetch = vi.fn(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = String(input);

    if (url.includes("down")) throw new TypeError("Load failed");

    if (url.includes("hang"))
      return await new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );

    if (url.includes("png"))
      return new Response(new Uint8Array(3000), {
        headers: { "content-type": "image/png" },
      });

    let body = url.includes("big") ? "x".repeat(maxBody + 10) : '{"ok":true}';
    return new Response(body, {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json", "x-a": "1" },
    });
  },
);

installPageFetchReader();

describe("without the main-world capture", () => {
  test("a frame fails loudly instead of waiting", async () => {
    expect(await pageFetch(request())).toMatchObject({
      ok: false,
      code: "not_actionable",
    });
  });
});

describe("page fetch", () => {
  let seenByPage: string[] = [];

  beforeAll(() => {
    window.fetch = browserFetch as typeof fetch;
    installNetworkCapture(window);
    // A page listener added after the capture's, as any page script's is.
    window.addEventListener(fetchEvent, () => seenByPage.push("request"), true);
    window.addEventListener(
      fetchAnswerEvent,
      () => seenByPage.push("answer"),
      true,
    );
    // A page that wraps fetch after load must not see or change the request.
    let wrapped = window.fetch;
    window.fetch = ((...args: Parameters<typeof fetch>) => {
      seenByPage.push("page fetch");
      return wrapped(...args);
    }) as typeof fetch;
  });

  afterEach(() => browserFetch.mockClear());

  test("sends with the browser's fetch, cookies included, and reads the answer", async () => {
    let answer = await pageFetch(
      request({ headers: [{ name: "X-CSRF-Token", value: "raw" }] }),
    );
    expect(answer).toEqual({
      ok: true,
      status: 201,
      statusText: "Created",
      url: expect.any(String),
      redirected: false,
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "x-a", value: "1" },
      ],
      contentType: "application/json",
      binary: false,
      size: 11,
      body: '{"ok":true}',
      truncated: false,
    });
    let [url, init] = browserFetch.mock.calls[0];
    expect(url).toBe(at("/api/items"));
    expect(init).toMatchObject({
      method: "GET",
      headers: [["X-CSRF-Token", "raw"]],
      body: null,
      credentials: "include",
    });
    expect(seenByPage).toEqual([]);
  });

  test("a binary body is counted, not read as text, and HEAD reads none", async () => {
    expect(await pageFetch(request({ url: at("/logo.png") }))).toMatchObject({
      binary: true,
      size: 3000,
      body: null,
    });
    expect(await pageFetch(request({ method: "HEAD" }))).toMatchObject({
      binary: false,
      size: 0,
      body: null,
    });
  });

  test("a long text body is cut at maxBody", async () => {
    let answer = await pageFetch(request({ url: at("/big") }));
    expect(answer).toMatchObject({ truncated: true, size: maxBody });
  });

  test("a network failure and a timeout keep their codes", async () => {
    expect(await pageFetch(request({ url: at("/down") }))).toMatchObject({
      ok: false,
      code: "failed",
      error: expect.stringContaining("TypeError: Load failed"),
    });
    expect(
      await pageFetch(request({ url: at("/hang"), timeoutMs: 20 })),
    ).toEqual({
      ok: false,
      error: "no whole response within 0.02 s, so the request was aborted",
      code: "timed_out",
    });
  });

  test("a replay without body sends the logged call's body as the page sent it", async () => {
    let time = Date.now();
    await window.fetch("/api/save", { method: "POST", body: '{"n":1}' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    browserFetch.mockClear();
    seenByPage.length = 0;
    let replay = { url: at("/api/save"), method: "POST", time };
    await pageFetch(request({ url: at("/api/save"), method: "POST", replay }));
    expect(browserFetch.mock.calls[0][1]).toMatchObject({ body: '{"n":1}' });
    await pageFetch(
      request({ url: at("/api/save"), method: "POST", replay, body: "{}" }),
    );
    expect(browserFetch.mock.calls[1][1]).toMatchObject({ body: "{}" });
    expect(seenByPage).toEqual([]);
  });

  test("a replay fails when the logged body was not kept as text or no call matches", async () => {
    let time = Date.now();
    let form = new FormData();
    form.append("file", new File(["abc"], "a.txt"));
    await window.fetch("/api/upload", { method: "POST", body: form });
    expect(
      await pageFetch(
        request({
          url: at("/api/upload"),
          method: "POST",
          replay: { url: at("/api/upload"), method: "POST", time },
        }),
      ),
    ).toMatchObject({
      ok: false,
      code: "invalid_argument",
      error: expect.stringContaining("not kept as text"),
    });
    expect(
      await pageFetch(
        request({
          method: "PUT",
          replay: { url: at("/never"), method: "PUT", time },
        }),
      ),
    ).toMatchObject({
      ok: false,
      code: "invalid_argument",
      error: expect.stringContaining("matches the logged request"),
    });
  });

  test("a forged answer without the request's id is ignored", async () => {
    let pending = pageFetch(request());
    window.dispatchEvent(
      new CustomEvent(fetchAnswerEvent, {
        detail: JSON.stringify({ id: "guess", answer: { status: 999 } }),
      }),
    );
    expect(await pending).toMatchObject({ status: 201 });
  });
});
