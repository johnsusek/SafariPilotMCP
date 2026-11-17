import type { BodyRecord, PageFetchAnswer } from "../shared/protocol";

// Keeps the bodies of the page's fetch and XMLHttpRequest calls, which webRequest cannot show; the background's webRequest log has every request's metadata.
// The isolated content script dispatches a take event whose detail is the request as JSON ({url, method, time}), and the capture answers synchronously
// with an answer event carrying the closest record as JSON, or "null". Both listen in the capture phase from document_start, like the console capture.
// A pending event ({since}, epoch ms) is answered the same way with how many calls started since then have not finished, which a page diff waits for.
export let takeEvent = "safaripilot-network-take";
export let pendingEvent = "safaripilot-network-pending";
export let answerEvent = "safaripilot-network-answer";
// page_fetch: the isolated script sends {id, url, method, headers, body, replay, timeoutMs} as JSON and the capture acks with {id, accepted: true} at once,
// then answers {id, answer} or {id, failure}. Its listener runs first and stops the event, so no page listener sees a request that may carry a replayed header.
export let fetchEvent = "safaripilot-fetch";
export let fetchAnswerEvent = "safaripilot-fetch-answer";
export let maxRecords = 200;
export let maxBody = 100000;
// page_fetch reads far more, since pick needs a whole JSON body and only max_chars of the reply goes back to the agent.
export let maxFetchBody = 5000000;
// webRequest stamps a request a little after the page called fetch or send, and a fetch from a service worker or a slow main thread later still.
export let matchWindowMs = 10000;

let textual =
  /^text\/(?!event-stream)|[/+](json|xml)\b|javascript|ecmascript|x-www-form-urlencoded|graphql/i;

export let isTextual = (contentType: string) => textual.test(contentType);

let clip = (text: string, limit = maxBody) =>
  text.length > limit
    ? { text: text.slice(0, limit), cut: true }
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
  let Search = page.URLSearchParams;
  let Abort = page.AbortController;
  let later = page.setTimeout.bind(page);
  let cancelLater = page.clearTimeout.bind(page);
  let originalFetch = page.fetch;
  let xhr = page.XMLHttpRequest.prototype;
  let originalOpen = xhr.open;
  let originalSend = xhr.send;
  let opened = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  // Records whose requestBody is the body exactly as sent (a string or URLSearchParams within maxBody), which a page_fetch replay may send again.
  let exactBodies = new WeakSet<BodyRecord>();
  let keepBody = (record: BodyRecord, body: unknown) => {
    if (
      (typeof body === "string" || body instanceof Search) &&
      String(body).length <= maxBody
    )
      exactBodies.add(record);
  };
  // Start times of calls whose response has not fully arrived; each call's done removes its own.
  let unfinished = new Set<{ time: number }>();
  let track = () => {
    let call = { time: now() };
    unfinished.add(call);
    return () => unfinished.delete(call);
  };
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

  // Reads a body as text up to limit characters, cancelling the rest; cut says there was more.
  let readText = async (
    body: ReadableStream<Uint8Array> | null,
    limit = maxBody,
  ) => {
    let reader = body?.getReader();
    let decoder = new Decoder();
    let text = "";

    while (reader) {
      let { done, value } = await reader.read();

      if (done) break;

      text += decoder.decode(value, { stream: true });

      if (text.length > limit) {
        reader.cancel().catch(() => {});
        return { text: text.slice(0, limit), cut: true };
      }
    }

    return clip(text + decoder.decode(), limit);
  };

  // Reads a clone of the response, so the page reads the original as it would have.
  let readResponse = async (record: BodyRecord, response: Response) => {
    finish(record, response.status, response.headers.get("content-type") ?? "");

    if (record.note !== null) return;

    let { text, cut } = await readText(response.clone().body);
    record.responseBody = text;
    record.truncated = cut;
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
        keepBody(record, body);

        // A Request's own body is read from a copy before fetch consumes it.
        if (body === null && request?.body)
          request
            .clone()
            .text()
            .then((text) => (record.requestBody = clip(text).text))
            .catch(() => {});

        let done = track();
        let pending: Promise<Response>;

        try {
          pending = apply(originalFetch, this, args) as Promise<Response>;
        } catch (error) {
          done();
          throw error;
        }

        pending
          .then(
            (response) =>
              readResponse(record, response).catch(
                (error) => (record.note = `body not read: ${error}`),
              ),
            (error) => (record.note = `failed: ${error}`),
          )
          .finally(done);
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
    let done = () => {};

    try {
      arm();
      done = track();
      this.addEventListener("loadend", () => done());
      let call = opened.get(this);

      if (call) {
        let record = start(call.method, call.url, describeBody(args[0], page));
        keepBody(record, args[0]);
        this.addEventListener("loadend", () => {
          try {
            if (this.status === 0) {
              record.note = "failed: no response";
              return;
            }

            finish(
              record,
              this.status,
              this.getResponseHeader("content-type") ?? "",
            );

            if (record.note !== null) return;

            let type = this.responseType;

            if (type !== "" && type !== "text" && type !== "json") {
              record.note = `not text (responseType ${type})`;
              return;
            }

            let text =
              type === "json" ? stringify(this.response) : this.responseText;
            let clipped = clip(text);
            record.responseBody = clipped.text;
            record.truncated = clipped.cut;
          } catch (error) {
            record.note = `body not read: ${error}`;
          }
        });
      }
    } catch {}

    try {
      return apply(originalSend, this, args);
    } catch (error) {
      done();
      throw error;
    }
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

  let countPending = (event: Event) => {
    let answer = "null";

    try {
      let since = Number(parse(String((event as CustomEvent).detail)).since);
      answer = String(
        [...unfinished].filter((call) => call.time >= since).length,
      );
    } catch {}

    dispatch(new Custom(answerEvent, { detail: answer }));
  };

  let failing = (error: string, code = "failed") => ({ error, code });

  // A text body is read up to maxFetchBody characters; a binary one has its bytes counted. The timeout's abort ends either read.
  let readBody = async (answer: PageFetchAnswer, response: Response) => {
    if (!response.body) return;

    if (isTextual(answer.contentType)) {
      let { text, cut } = await readText(response.body, maxFetchBody);
      answer.body = text;
      answer.size = text.length;
      answer.truncated = cut;
      return;
    }

    let reader = response.body.getReader();
    answer.binary = true;

    for (;;) {
      let part = await reader.read();

      if (part.done) break;

      answer.size += part.value.byteLength;
    }
  };

  let sendFromPage = async (request: Record<string, unknown>) => {
    let method = String(request.method);
    let body = request.body === null ? null : String(request.body);
    let replay = request.replay as Record<string, unknown> | null;

    if (replay && body === null && method !== "GET" && method !== "HEAD") {
      let record = closest(
        records,
        String(replay.url),
        String(replay.method),
        Number(replay.time),
      );

      if (!record)
        throw failing(
          "no fetch or XMLHttpRequest call in this frame matches the logged request, so its body is unknown; pass body",
          "invalid_argument",
        );

      if (record.requestBody !== null && !exactBodies.has(record))
        throw failing(
          `the logged request's body was not kept as text (form data, a file, binary data or over ${maxBody} characters); pass body`,
          "invalid_argument",
        );

      body = record.requestBody;
    }

    let timeoutMs = Number(request.timeoutMs);
    let controller = new Abort();
    let timer = later(() => controller.abort(), timeoutMs);

    try {
      let response = (await apply(originalFetch, page, [
        String(request.url),
        {
          method,
          headers: (request.headers as { name: string; value: string }[]).map(
            ({ name, value }) => [String(name), String(value)],
          ),
          body,
          credentials: "include",
          signal: controller.signal,
        },
      ])) as Response;
      let answer: PageFetchAnswer = {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        redirected: response.redirected,
        headers: [...response.headers].map(([name, value]) => ({
          name,
          value,
        })),
        contentType: response.headers.get("content-type") ?? "",
        binary: false,
        size: 0,
        body: null,
        truncated: false,
      };

      if (method !== "HEAD") await readBody(answer, response);

      return answer;
    } catch (error) {
      if (controller.signal.aborted)
        throw failing(
          `no whole response within ${timeoutMs / 1000} s, so the request was aborted`,
          "timed_out",
        );

      throw failing(
        `the request failed: ${error}; a network error, or the server's CORS rules refuse a credentialed request from this page`,
      );
    } finally {
      cancelLater(timer);
    }
  };

  let serve = (event: Event) => {
    event.stopImmediatePropagation();
    let request: Record<string, unknown>;

    try {
      request = Object(parse(String((event as CustomEvent).detail)));
    } catch {
      return;
    }

    let reply = (message: object) =>
      dispatch(
        new Custom(fetchAnswerEvent, {
          detail: stringify({ id: String(request.id), ...message }),
        }),
      );
    reply({ accepted: true });
    sendFromPage(request).then(
      (answer) => reply({ answer }),
      (failure) =>
        reply({
          failure:
            typeof failure?.code === "string"
              ? failure
              : failing(`page_fetch failed: ${failure}`),
        }),
    );
  };

  // document.open() erases a window's listeners, so every fetch and send adds the listeners again; adding one already there does nothing.
  function arm() {
    listen(takeEvent, take, true);
    listen(pendingEvent, countPending, true);
    listen(fetchEvent, serve, true);
  }

  arm();
}
