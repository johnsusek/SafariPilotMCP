import { answerEvent, maxBody, takeEvent } from "../main/network";
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

export function takeBody(
  url: string,
  method: string,
  time: number,
): NetworkBodyResult {
  // document.open() erases the window's listeners, so the reader is added again; a listener already there is not added twice.
  installNetworkReader();
  waiting = true;
  reply = undefined;
  window.dispatchEvent(
    new CustomEvent(takeEvent, {
      detail: JSON.stringify({ url, method, time }),
    }),
  );
  waiting = false;

  if (typeof reply !== "string")
    return { ok: true, capturing: false, record: null };

  let parsed = JSON.parse(reply) as unknown;
  return {
    ok: true,
    capturing: true,
    record: parsed === null ? null : recordOf(Object(parsed)),
  };
}
