import type { ConsoleEntry, ConsoleLevel } from "../shared/protocol";

// The isolated content script dispatches a take event and the capture answers synchronously with an entries event carrying the buffer as JSON.
// Both register capture-phase window listeners at document_start, before any page script, so a page listener can neither answer first nor stop them.
export let takeEvent = "safaripilot-console-take";
export let takeClearEvent = "safaripilot-console-take-clear";
export let entriesEvent = "safaripilot-console-entries";
export let maxEntries = 1000;
export let maxText = 2000;
let maxNested = 200;
let maxItems = 20;
let maxDepth = 2;
let wrapped = ["log", "info", "warn", "error", "debug"] as const;
let locationPattern = /([^\s@(]+:\d+:\d+)\)?$/;
let tagOf = Object.prototype.toString;

let clip = (text: string, max: number) =>
  text.length > max
    ? `${text.slice(0, max)}... (${text.length - max} more characters)`
    : text;

// The first url:line:column in a JSC (name@url:1:2) or V8 (at name (url:1:2)) stack that is not in this script.
export function callerOf(stack: string, own: string | null) {
  for (let line of stack.split("\n")) {
    let location = line.trim().match(locationPattern)?.[1];

    if (location && (own === null || !location.startsWith(own)))
      return location;
  }

  return null;
}

// Shows a value roughly as the console would, never throwing: depth and item counts are capped and cycles named.
export function formatValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
): string {
  if (typeof value === "string")
    return depth === 0 ? value : JSON.stringify(clip(value, maxNested));
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function")
    return `[function ${value.name || "anonymous"}]`;
  if (typeof value !== "object" || value === null) return String(value);
  if (seen.has(value)) return "[circular]";

  try {
    let tag = tagOf.call(value).slice(8, -1);
    let object = value as Record<string, unknown>;

    if (tag === "Error" || tag === "DOMException") {
      let head = `${object.name}: ${object.message}`;
      let stack = typeof object.stack === "string" ? object.stack : "";

      if (depth > 0 || !stack) return head;

      return stack.includes(head) ? stack : `${head}\n${stack}`;
    }

    if (tag === "Date")
      return isNaN(+value) ? "Invalid Date" : (value as Date).toISOString();
    if (tag === "RegExp") return String(value);

    if (
      typeof object.nodeType === "number" &&
      typeof object.nodeName === "string"
    ) {
      if (object.nodeType !== 1) return `${object.nodeName}`.toLowerCase();

      let element = value as Element;
      let id = element.id ? `#${element.id}` : "";
      let classes = [...element.classList].map((name) => `.${name}`).join("");
      return `<${element.localName}${id}${classes}>`;
    }

    if (object.window === value) return "[Window]";

    let isArray = Array.isArray(value);

    if (depth >= maxDepth)
      return isArray ? `[Array(${(value as unknown[]).length})]` : `[${tag}]`;

    seen.add(value);
    let item = (read: () => unknown) => {
      try {
        return formatValue(read(), depth + 1, seen);
      } catch {
        return "[threw]";
      }
    };
    let list = (items: string[], total: number) =>
      total > maxItems
        ? [...items, `... ${total - maxItems} more`].join(", ")
        : items.join(", ");
    let shown: string;

    if (isArray) {
      let array = value as unknown[];
      let items = array
        .slice(0, maxItems)
        .map((_, index) => item(() => array[index]));
      shown = `[${list(items, array.length)}]`;
    } else if (tag === "Map" || tag === "Set") {
      let collection = value as Map<unknown, unknown> | Set<unknown>;
      let pairs = [...collection.entries()].slice(0, maxItems);
      let items = pairs.map(([key, entry]) =>
        tag === "Map"
          ? `${item(() => key)} => ${item(() => entry)}`
          : item(() => entry),
      );
      shown = `${tag}(${collection.size}) {${list(items, collection.size)}}`;
    } else {
      let keys = Object.keys(value);
      let items = keys
        .slice(0, maxItems)
        .map((key) => `${key}: ${item(() => object[key])}`);
      let prefix = tag === "Object" ? "" : `${tag} `;
      shown = `${prefix}{${list(items, keys.length)}}`;
    }

    seen.delete(value);
    return shown;
  } catch {
    seen.delete(value);
    return "[unreadable]";
  }
}

// Joins console arguments with spaces, first applying the format specifiers of a leading string as the console does (%c styles are dropped).
export function formatArgs(args: unknown[]) {
  let rest = [...args];
  let parts: string[] = [];

  if (typeof rest[0] === "string" && rest.length > 1) {
    let format = rest.shift() as string;
    parts.push(
      format.replace(/%([sdifoOc%])/g, (match, kind: string) => {
        if (kind === "%") return "%";
        if (!rest.length) return match;

        let value = rest.shift();

        if (kind === "c") return "";
        if (kind === "d" || kind === "i")
          return String(Math.trunc(Number(value)));
        if (kind === "f") return String(Number(value));
        return formatValue(value, 0, new Set());
      }),
    );
  }

  parts.push(...rest.map((value) => formatValue(value, 0, new Set())));
  return clip(parts.join(" "), maxText);
}

// Wraps the console methods and records uncaught errors and unhandled rejections the page did not cancel; the page's console keeps working as before.
// Page globals the capture relies on later are read now, before any page script can replace them.
export function installCapture(page: Window & typeof globalThis) {
  let buffer: ConsoleEntry[] = [];
  let dropped = 0;
  // Set while formatting, so a getter that logs does not recurse.
  let formatting = false;
  let now = Date.now;
  let apply = Reflect.apply;
  let stringify = JSON.stringify;
  let later = page.setTimeout.bind(page);
  let dispatch = page.dispatchEvent.bind(page);
  let listen = page.addEventListener.bind(page);
  let Custom = page.CustomEvent;
  let ErrorEventType = page.ErrorEvent;
  let ownLocation = callerOf(new Error().stack ?? "", null);
  let own = ownLocation?.replace(/:\d+:\d+$/, "") ?? null;
  let record = (
    level: ConsoleLevel,
    text: string,
    source: string | null,
    time: number,
  ) => {
    if (buffer.length >= maxEntries) {
      buffer.shift();
      dropped++;
    }

    buffer.push({ level, text, time, url: page.location.href, source });
  };

  for (let level of wrapped) {
    let original = page.console[level];

    if (typeof original !== "function") continue;

    // A method, so it keeps the original's name and this.
    page.console[level] = {
      [level](this: unknown, ...args: unknown[]) {
        try {
          arm();
        } catch {}

        if (!formatting) {
          formatting = true;

          try {
            record(
              level,
              formatArgs(args),
              callerOf(new Error().stack ?? "", own),
              now(),
            );
          } catch {}

          formatting = false;
        }

        return apply(original, this, args);
      },
    }[level];
  }

  // A page listener may cancel the event to keep it out of the console, so the check waits until dispatch is over; a microtask would run between listeners.
  let onError = (event: Event) => {
    if (!(event instanceof ErrorEventType)) return;

    let time = now();
    later(() => {
      try {
        if (event.defaultPrevented) return;

        let thrown = event.error;
        let text =
          thrown === undefined || thrown === null
            ? event.message.replace(/^Uncaught /, "")
            : formatValue(thrown, 0, new Set());
        let source = event.filename
          ? `${event.filename}:${event.lineno}:${event.colno}`
          : null;
        record("exception", clip(`Uncaught ${text}`, maxText), source, time);
      } catch {}
    });
  };
  let onRejection = (event: PromiseRejectionEvent) => {
    let time = now();
    later(() => {
      try {
        if (event.defaultPrevented) return;

        let reason = event.reason;
        let stack = (reason as { stack?: unknown } | null)?.stack;
        let source = typeof stack === "string" ? callerOf(stack, own) : null;
        let text = `Unhandled Promise Rejection: ${formatValue(reason, 0, new Set())}`;
        record("exception", clip(text, maxText), source, time);
      } catch {}
    });
  };
  let answer = (clear: boolean) => () => {
    let detail = stringify({ entries: buffer, dropped });

    if (clear) {
      buffer = [];
      dropped = 0;
    }

    dispatch(new Custom(entriesEvent, { detail }));
  };
  let take = answer(false);
  let takeClear = answer(true);

  // Capture phase, so no page listener registered later runs first. document.open() erases a window's listeners (document.write frames),
  // so every console call adds them again; adding a listener that is already there does nothing.
  function arm() {
    listen("error", onError, true);
    listen("unhandledrejection", onRejection, true);
    listen(takeEvent, take, true);
    listen(takeClearEvent, takeClear, true);
  }

  arm();
}
