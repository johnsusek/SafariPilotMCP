// @vitest-environment happy-dom
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
  closest,
  describeBody,
  installNetworkCapture,
  isTextual,
  maxBody,
  matchWindowMs,
} from "../main/network";
import type { BodyRecord } from "../shared/protocol";
import { installNetworkReader, takeBody } from "./network";

let tick = () => new Promise((resolve) => setTimeout(resolve, 5));
let origin = location.href;
let at = (path: string) => new URL(path, origin).href;
let pageFetch = vi.fn(
  async (input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(
      String(input).includes("big") ? "x".repeat(maxBody + 50) : '{"ok":true}',
      {
        status: 201,
        headers: {
          "content-type": String(input).includes("png")
            ? "image/png"
            : "application/json",
        },
      },
    ),
);

installNetworkReader();

describe("without the main-world script", () => {
  test("a frame reports no capture", () => {
    expect(takeBody(at("/a"), "GET", Date.now())).toEqual({
      ok: true,
      capturing: false,
      record: null,
    });
  });
});

describe("network capture", () => {
  beforeAll(() => {
    window.fetch = pageFetch as typeof fetch;
    let proto = window.XMLHttpRequest.prototype;
    // A stand-in transport: send answers at once with a JSON body.
    proto.open = function () {} as typeof proto.open;
    proto.send = function (this: XMLHttpRequest) {
      Object.defineProperty(this, "status", { value: 200 });
      Object.defineProperty(this, "responseText", {
        value: '{"token":"abc","n":1}',
      });
      this.getResponseHeader = () => "application/json";
      setTimeout(() => this.dispatchEvent(new Event("loadend")));
    } as typeof proto.send;
    installNetworkCapture(window);
  });

  test("fetch keeps the request and response bodies and passes the page the response", async () => {
    let time = Date.now();
    let response = await window.fetch("/api/items", {
      method: "post",
      body: '{"name":"a"}',
    });
    expect(await response.json()).toEqual({ ok: true });
    await tick();
    let { record } = takeBody(at("/api/items"), "POST", time);
    expect(record).toMatchObject({
      method: "POST",
      url: at("/api/items"),
      requestBody: '{"name":"a"}',
      status: 201,
      contentType: "application/json",
      responseBody: '{"ok":true}',
      truncated: false,
      note: null,
    });
    expect(pageFetch).toHaveBeenCalledWith("/api/items", {
      method: "post",
      body: '{"name":"a"}',
    });
  });

  test("a binary response is noted, not read", async () => {
    await window.fetch("/logo.png");
    await tick();
    expect(takeBody(at("/logo.png"), "GET", Date.now()).record).toMatchObject({
      responseBody: null,
      note: "not text (image/png)",
    });
  });

  test("a long body is cut at maxBody", async () => {
    await window.fetch("/big");
    await tick();
    let { record } = takeBody(at("/big"), "GET", Date.now());
    expect(record?.responseBody).toHaveLength(maxBody);
    expect(record?.truncated).toBe(true);
  });

  test("a rejected fetch is noted and still rejects for the page", async () => {
    pageFetch.mockRejectedValueOnce(new TypeError("Load failed"));
    await expect(window.fetch("/down")).rejects.toThrow("Load failed");
    await tick();
    expect(takeBody(at("/down"), "GET", Date.now()).record?.note).toBe(
      "failed: TypeError: Load failed",
    );
  });

  test("XMLHttpRequest keeps its bodies", async () => {
    let request = new window.XMLHttpRequest();
    request.open("PUT", "/api/x");
    request.send("a=1&password=2");
    await tick();
    expect(takeBody(at("/api/x"), "PUT", Date.now()).record).toMatchObject({
      requestBody: "a=1&password=2",
      status: 200,
      responseBody: '{"token":"abc","n":1}',
    });
  });

  test("a request with no matching call answers null", () => {
    expect(takeBody(at("/never"), "GET", Date.now())).toEqual({
      ok: true,
      capturing: true,
      record: null,
    });
  });
});

describe("closest", () => {
  let record = (time: number): BodyRecord => ({
    method: "GET",
    url: "https://a.test/",
    time,
    requestBody: null,
    status: 200,
    contentType: "",
    responseBody: null,
    truncated: false,
    note: null,
  });

  test("picks the call started nearest the request, within the window", () => {
    let records = [record(1000), record(5000), record(9000)];
    expect(closest(records, "https://a.test/", "GET", 5200)?.time).toBe(5000);
    expect(closest(records, "https://a.test/", "POST", 5200)).toBeNull();
    expect(
      closest([record(0)], "https://a.test/", "GET", matchWindowMs + 1),
    ).toBeNull();
  });
});

test("textual content types", () => {
  for (let type of [
    "text/html; charset=utf-8",
    "application/json",
    "application/ld+json",
    "application/xml",
    "text/javascript",
    "application/x-www-form-urlencoded",
  ])
    expect(isTextual(type), type).toBe(true);

  for (let type of [
    "image/png",
    "text/event-stream",
    "application/octet-stream",
    "",
  ])
    expect(isTextual(type), type).toBe(false);
});

test("request bodies as text", () => {
  let form = new FormData();
  form.append("q", "cats");
  form.append("file", new File(["abc"], "a.txt"));
  expect(describeBody(form, window)).toBe("q=cats&file=[file a.txt, 3 bytes]");
  expect(describeBody(new URLSearchParams({ a: "1" }), window)).toBe("a=1");
  expect(describeBody(new Uint8Array(4), window)).toBe("[4 bytes]");
  expect(describeBody(undefined, window)).toBeNull();
});
