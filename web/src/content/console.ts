import {
  entriesEvent,
  maxText,
  takeClearEvent,
  takeEvent,
} from "../main/console";
import type {
  ConsoleEntry,
  ConsoleLevel,
  ConsoleResult,
} from "../shared/protocol";

let levels = new Set<string>([
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "exception",
]);
let waiting = false;
let reply: unknown;

// Only the first answer to each take counts.
let onEntries = (event: Event) => {
  if (!waiting) return;

  waiting = false;
  reply = (event as CustomEvent).detail;
};

// Registered at document_start, before any page script, so a page's capture listener cannot stop it.
export let installReader = () =>
  window.addEventListener(entriesEvent, onEntries, true);

// The answer is page data: every field is coerced to its type, so a forged one can at worst show wrong messages.
let entryOf = (raw: Record<string, unknown>): ConsoleEntry => ({
  level: levels.has(raw.level as string) ? (raw.level as ConsoleLevel) : "log",
  text: String(raw.text).slice(0, maxText + 100),
  time: Number(raw.time) || 0,
  url: String(raw.url),
  source: typeof raw.source === "string" ? raw.source : null,
});

export function takeConsole(
  onlyErrors: boolean,
  pattern: string | null,
  limit: number,
  clear: boolean,
): ConsoleResult {
  // document.open() erases the window's listeners, so the reader is added again; a listener already there is not added twice.
  installReader();
  waiting = true;
  reply = undefined;
  window.dispatchEvent(new CustomEvent(clear ? takeClearEvent : takeEvent));
  waiting = false;

  if (typeof reply !== "string")
    return { ok: true, capturing: false, entries: [], matched: 0, dropped: 0 };

  let parsed = JSON.parse(reply) as { entries?: unknown; dropped?: unknown };

  if (!Array.isArray(parsed.entries))
    throw new Error("the console capture answered without entries");

  let match = pattern === null ? null : new RegExp(pattern, "i");
  let kept = parsed.entries
    .map((raw) => entryOf(Object(raw)))
    .filter(
      (entry) =>
        (!onlyErrors ||
          entry.level === "error" ||
          entry.level === "exception") &&
        (!match || match.test(entry.text)),
    );
  return {
    ok: true,
    capturing: true,
    entries: kept.slice(-limit),
    matched: kept.length,
    dropped: Number(parsed.dropped) || 0,
  };
}
