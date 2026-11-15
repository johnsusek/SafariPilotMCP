import { answerEvent, maxBody, pendingEvent, takeEvent } from "../main/network";
import type { BodyRecord, NetworkBodyResult } from "../shared/protocol";

let waiting = false;
let reply: unknown;

// Only the first answer to each take counts.
let onAnswer = (event: Event) => {
  if (!waiting) return;

  waiting = false;
  reply = (event as CustomEvent).detail;
};

// Registered at document_start, before any page script, so a page's answer listener cannot stop it.
export let installNetworkReader = () =>
  window.addEventListener(answerEvent, onAnswer, true);

let text = (value: unknown) =>
  typeof value === "string" ? value.slice(0, maxBody) : null;

// The answer is page data: every field is coerced to its type, so a forged one can at worst show a wrong body.
let recordOf = (raw: Record<string, unknown>): BodyRecord => ({
  method: String(raw.method),
  url: String(raw.url),
  time: Number(raw.time) || 0,
  requestBody: text(raw.requestBody),
  status: typeof raw.status === "number" ? raw.status : null,
  contentType: String(raw.contentType ?? ""),
  responseBody: text(raw.responseBody),
  truncated: raw.truncated === true,
  note: text(raw.note),
});

// Asks the main-world capture, which answers synchronously; undefined when no capture answered.
function ask(type: string, detail: unknown) {
  // document.open() erases the window's listeners, so the reader is added again; a listener already there is not added twice.
  installNetworkReader();
  waiting = true;
  reply = undefined;
  window.dispatchEvent(
    new CustomEvent(type, { detail: JSON.stringify(detail) }),
  );
  waiting = false;
  return typeof reply === "string" ? reply : undefined;
}

// How many of this frame's fetch and XMLHttpRequest calls started at or after since (epoch ms) have not finished; null when no capture answered.
export function pendingSince(since: number) {
  let count = Number(ask(pendingEvent, { since }));
  return Number.isInteger(count) && count >= 0 ? count : null;
}

export function takeBody(
  url: string,
  method: string,
  time: number,
): NetworkBodyResult {
  let answer = ask(takeEvent, { url, method, time });

  if (answer === undefined) return { ok: true, capturing: false, record: null };

  let parsed = JSON.parse(answer) as unknown;
  return {
    ok: true,
    capturing: true,
    record: parsed === null ? null : recordOf(Object(parsed)),
  };
}
