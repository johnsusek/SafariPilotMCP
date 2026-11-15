import { fetchAnswerEvent, fetchEvent, maxBody } from "../main/network";
import type {
  ContentRequest,
  ErrorCode,
  Failure,
  PageFetchAnswer,
} from "../shared/protocol";

type Message = Record<string, unknown>;

// Requests waiting for the main-world capture, by id; each takes the ack and then the answer.
let waiting = new Map<string, (message: Message) => void>();

let onAnswer = (event: Event) => {
  let message: Message;

  try {
    message = Object(JSON.parse(String((event as CustomEvent).detail)));
  } catch {
    return;
  }

  let deliver = waiting.get(String(message.id));

  if (!deliver) return;

  event.stopImmediatePropagation();
  deliver(message);
};

// Registered at document_start, before any page script, so no page listener sees an answer before it.
export let installPageFetchReader = () =>
  window.addEventListener(fetchAnswerEvent, onAnswer, true);

let randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

// The answer is page data: every field is coerced to its type.
let answerOf = (raw: Message): PageFetchAnswer => ({
  ok: true,
  status: Number(raw.status) || 0,
  statusText: String(raw.statusText ?? ""),
  url: String(raw.url ?? ""),
  redirected: raw.redirected === true,
  headers: (Array.isArray(raw.headers) ? raw.headers : []).map((header) => ({
    name: String(header?.name),
    value: String(header?.value),
  })),
  contentType: String(raw.contentType ?? ""),
  binary: raw.binary === true,
  size: Number(raw.size) || 0,
  body: typeof raw.body === "string" ? raw.body.slice(0, maxBody) : null,
  truncated: raw.truncated === true,
});

let codes: ErrorCode[] = ["invalid_argument", "timed_out", "failed"];

export async function pageFetch(
  request: Extract<ContentRequest, { op: "pageFetch" }>,
): Promise<PageFetchAnswer | Failure> {
  // document.open() erases the window's listeners, so the reader is added again; a listener already there is not added twice.
  installPageFetchReader();
  let id = randomId();
  let accepted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answered = new Promise<Message | null>((resolve) => {
    waiting.set(id, (message) => {
      if (message.accepted === true) accepted = true;
      else resolve(message);
    });
    // The capture aborts at timeoutMs and answers; this is for a capture that never does.
    timer = setTimeout(() => resolve(null), request.timeoutMs + 2000);
  });

  try {
    let { op: _op, ...detail } = request;
    window.dispatchEvent(
      new CustomEvent(fetchEvent, {
        detail: JSON.stringify({ id, ...detail }),
      }),
    );

    if (!accepted)
      return {
        ok: false,
        error:
          "no main-world capture answered in this frame: it runs no scripts (sandboxed), or document.open() replaced its document and no fetch has armed the capture since; reload the page",
        code: "not_actionable",
      };

    let message = await answered;

    if (!message)
      return {
        ok: false,
        error: `the page did not answer within ${request.timeoutMs / 1000 + 2} s`,
        code: "timed_out",
      };

    if (message.failure) {
      let failure = Object(message.failure) as Message;
      let code = codes.find((known) => known === failure.code) ?? "failed";
      return { ok: false, error: String(failure.error), code };
    }

    return answerOf(Object(message.answer));
  } finally {
    clearTimeout(timer);
    waiting.delete(id);
  }
}
