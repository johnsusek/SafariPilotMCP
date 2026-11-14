import type { BodyRecord } from "../shared/protocol";

// Keeps the bodies of the page's fetch and XMLHttpRequest calls, which webRequest cannot show; the background's webRequest log has every request's metadata.
// The isolated content script dispatches a take event whose detail is the request as JSON ({url, method, time}), and the capture answers synchronously
// with an answer event carrying the closest record as JSON, or "null". Both listen in the capture phase from document_start, like the console capture.
export let takeEvent = "safaripilot-network-take";
export let answerEvent = "safaripilot-network-answer";
export let maxRecords = 200;
export let maxBody = 100000;
// webRequest stamps a request a little after the page called fetch or send, and a fetch from a service worker or a slow main thread later still.
export let matchWindowMs = 10000;

let textual =
  /^text\/(?!event-stream)|[/+](json|xml)\b|javascript|ecmascript|x-www-form-urlencoded|graphql/i;

export let isTextual = (contentType: string) => textual.test(contentType);

let clip = (text: string) =>
  text.length > maxBody
    ? { text: text.slice(0, maxBody), cut: true }
    : { text, cut: false };

// What a request carries, as text: strings and form data as written (a file as its name and size), binary bodies by size.
export function describeBody(
  body: unknown,
  page: Window & typeof globalThis,
): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return clip(body).text;
  if (body instanceof page.URLSearchParams) return clip(body.toString()).text;

  if (body instanceof page.FormData) {
    let fields = [...body].map(([name, value]) =>
      typeof value === "string"
        ? `${name}=${value}`
        : `${name}=[file ${value.name}, ${value.size} bytes]`,
    );
    return clip(fields.join("&")).text;
  }

  if (body instanceof page.Blob)
    return `[blob ${body.type || "untyped"}, ${body.size} bytes]`;
  if (body instanceof page.ArrayBuffer || ArrayBuffer.isView(body))
    return `[${(body as ArrayBuffer).byteLength} bytes]`;
  if (body instanceof page.ReadableStream) return "[stream]";
  if (body instanceof page.Document) return "[document]";

  return `[${Object.prototype.toString.call(body).slice(8, -1)}]`;
}

// The record of the same method and URL started closest to time, if one started within matchWindowMs of it.
export function closest(
  records: BodyRecord[],
  url: string,
  method: string,
  time: number,
) {
  let best: BodyRecord | null = null;

  for (let record of records) {
    if (record.url !== url || record.method !== method) continue;

    let gap = Math.abs(record.time - time);

    if (gap <= matchWindowMs && (!best || gap < Math.abs(best.time - time)))
      best = record;
  }

  return best;
}

export function installNetworkCapture(page: Window & typeof globalThis) {
  let records: BodyRecord[] = [];
  let now = Date.now;
  let apply = Reflect.apply;
  let stringify = JSON.stringify;
  let parse = JSON.parse;
  let dispatch = page.dispatchEvent.bind(page);
  let listen = page.addEventListener.bind(page);
  let Custom = page.CustomEvent;
  let Url = page.URL;
  let Decoder = page.TextDecoder;
  let RequestType = page.Request;
  let originalFetch = page.fetch;
  let xhr = page.XMLHttpRequest.prototype;
  let originalOpen = xhr.open;
  let originalSend = xhr.send;
  let opened = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  let absolute = (url: string) => {
    try {
      return new Url(url, page.location.href).href;
    } catch {
      return url;
    }
  };
  let start = (
    method: string,
    url: string,
    requestBody: string | null,
  ): BodyRecord => {
    let record: BodyRecord = {
      method: method.toUpperCase(),
      url: absolute(url),
      time: now(),
      requestBody,
      status: null,
      contentType: "",
      responseBody: null,
      truncated: false,
      note: "still loading",
    };

    if (records.length >= maxRecords) records.shift();

    records.push(record);
    return record;
  };
  let finish = (record: BodyRecord, status: number, contentType: string) => {
    record.status = status;
    record.contentType = contentType;
    record.note = isTextual(contentType)
      ? null
      : `not text (${contentType || "no content type"})`;
  };

  // Reads a clone of the response up to maxBody characters, then cancels it; the page reads the original as it would have.
  let readResponse = async (record: BodyRecord, response: Response) => {
    finish(record, response.status, response.headers.get("content-type") ?? "");

    if (record.note !== null) return;

    let reader = response.clone().body?.getReader();
    let decoder = new Decoder();
    let text = "";

    while (reader) {
      let { done, value } = await reader.read();

      if (done) break;

      text += decoder.decode(value, { stream: true });

      if (text.length > maxBody) {
        record.truncated = true;
        reader.cancel().catch(() => {});
        break;
      }
    }

    record.responseBody = clip(
      text + (record.truncated ? "" : decoder.decode()),
    ).text;
  };

  page.fetch = {
    fetch(this: unknown, ...args: Parameters<typeof fetch>) {
      try {
        arm();
        let [input, init] = args;
        let request = input instanceof RequestType ? input : null;
        let method = init?.method ?? request?.method ?? "GET";
        let url = request ? request.url : String(input);
        let body = init?.body ?? null;
        let record = start(method, url, describeBody(body, page));

        // A Request's own body is read from a copy before fetch consumes it.
        if (body === null && request?.body)
          request
            .clone()
            .text()
            .then((text) => (record.requestBody = clip(text).text))
            .catch(() => {});

        let pending = apply(originalFetch, this, args) as Promise<Response>;
        pending.then(
          (response) =>
            readResponse(record, response).catch(
              (error) => (record.note = `body not read: ${error}`),
            ),
          (error) => (record.note = `failed: ${error}`),
        );
        return pending;
      } catch {
        return apply(originalFetch, this, args);
      }
    },
  }.fetch;

  xhr.open = function open(this: XMLHttpRequest, ...args: unknown[]) {
    try {
      opened.set(this, { method: String(args[0]), url: String(args[1]) });
    } catch {}

    return apply(originalOpen, this, args);
  } as typeof xhr.open;

  xhr.send = function send(this: XMLHttpRequest, ...args: unknown[]) {
    try {
      arm();
      let call = opened.get(this);

      if (call) {
        let record = start(call.method, call.url, describeBody(args[0], page));
        let request = this;
        request.addEventListener("loadend", () => {
          try {
            if (request.status === 0) {
              record.note = "failed: no response";
              return;
            }

            finish(
              record,
              request.status,
              request.getResponseHeader("content-type") ?? "",
            );

            if (record.note !== null) return;

            let type = request.responseType;

            if (type !== "" && type !== "text" && type !== "json") {
              record.note = `not text (responseType ${type})`;
              return;
            }

            let text =
              type === "json"
                ? stringify(request.response)
                : request.responseText;
            let clipped = clip(text);
            record.responseBody = clipped.text;
            record.truncated = clipped.cut;
          } catch (error) {
            record.note = `body not read: ${error}`;
          }
        });
      }
    } catch {}

    return apply(originalSend, this, args);
  } as typeof xhr.send;

  let take = (event: Event) => {
    let answer = "null";

    try {
      let { url, method, time } = parse(String((event as CustomEvent).detail));
      answer = stringify(
        closest(records, String(url), String(method), Number(time)),
      );
    } catch {}

    dispatch(new Custom(answerEvent, { detail: answer }));
  };

  // document.open() erases a window's listeners, so every fetch and send adds the take listener again; adding one already there does nothing.
  function arm() {
    listen(takeEvent, take, true);
  }

  arm();
}
