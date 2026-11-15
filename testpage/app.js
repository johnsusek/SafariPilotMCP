let loggedTypes = [
  "pointerover",
  "pointerdown",
  "pointerup",
  "pointercancel",
  "mouseover",
  "mousedown",
  "mouseup",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
  "focusin",
  "focusout",
  "keydown",
  "keypress",
  "keyup",
  "beforeinput",
  "input",
  "change",
  "submit",
  "dragstart",
  "dragenter",
  "dragleave",
  "drop",
  "dragend",
];

let counterNames = [
  "underHeader",
  "native",
  "link",
  "checkbox",
  "radio",
  "text",
  "textarea",
  "select",
  "time",
  "date",
  "editable",
  "pointerDown",
  "mouseUp",
  "clickDiv",
  "dblclick",
  "contextmenu",
  "auxclick",
  "menuItem",
  "drop",
  "inScroller",
  "covered",
  "scaled",
  "disabled",
  "far",
];

let logLimit = 300;
let nextId = 1;

function targetName(target) {
  if (target === window) return "window";
  if (target === document) return "document";
  if (!(target instanceof Element)) return String(target);
  return target.id ? `${target.localName}#${target.id}` : target.localName;
}

function modifiersOf(event) {
  return ["ctrl", "shift", "alt", "meta"]
    .filter((name) => event[`${name}Key`])
    .join("+");
}

function detailOf(event) {
  if (event instanceof MouseEvent)
    return `b${event.button} d${event.detail} ${event.clientX},${event.clientY} ${modifiersOf(event)}`.trim();
  if (event instanceof KeyboardEvent) return event.key;
  if (event instanceof InputEvent) return event.inputType;
  return "";
}

document.addEventListener("alpine:init", () => {
  Alpine.data("lab", () => ({
    counts: Object.fromEntries(counterNames.map((name) => [name, 0])),
    values: {
      text: "",
      textarea: "",
      select: "One",
      time: "",
      date: "",
      clickDetail: 0,
      modifiers: "",
      dialog: "",
      files: {},
      console: "",
      range: "10",
      ariaSlider: 4,
    },
    log: [],

    // Steps by 2 like an APG slider, ArrowUp and ArrowRight raising it, PageUp and PageDown by 10.
    slide(event) {
      let moves = {
        ArrowRight: 2,
        ArrowUp: 2,
        ArrowLeft: -2,
        ArrowDown: -2,
        PageUp: 10,
        PageDown: -10,
      };
      let ends = { Home: 0, End: 20 };

      if (!(event.key in moves) && !(event.key in ends)) return;

      event.preventDefault();
      let next = ends[event.key] ?? this.values.ariaSlider + moves[event.key];
      this.values.ariaSlider = Math.min(20, Math.max(0, next));
    },

    init() {
      for (let type of loggedTypes) {
        window.addEventListener(type, (event) => this.record(event), {
          capture: true,
          passive: true,
        });
      }
    },

    record(event) {
      let entry = {
        id: nextId++,
        time: event.timeStamp.toFixed(1),
        type: event.type,
        target: targetName(event.composedPath()[0] ?? event.target),
        trusted: event.isTrusted,
        detail: detailOf(event),
      };
      this.log = [entry, ...this.log.slice(0, logLimit - 1)];
    },

    modifiersOf,

    // Each file as name, size, type and its first 8 bytes in hex, so an upload shows what arrived byte for byte.
    async showFiles(name, files) {
      let lines = await Promise.all(
        Array.from(files, async (file) => {
          let head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
          let hex = Array.from(head, (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(" ");
          return `${file.name} ${file.size} B ${file.type || "no type"} [${hex}]`;
        }),
      );
      this.values.files[name] = lines.join(" | ") || "none";
    },

    bump(name) {
      this.counts[name]++;
    },

    reset() {
      for (let name of counterNames) this.counts[name] = 0;
      this.values.files = {};
      this.log = [];
    },

    synthetic() {
      document.getElementById("native").click();
    },

    // One message at each level, then an uncaught error and an unhandled rejection, for read_console_messages.
    consoleBurst() {
      let cycle = { name: "lab" };
      cycle.self = cycle;
      console.log("lab log %s", "formatted", cycle);
      console.info("lab info");
      console.warn("lab warn");
      console.error("lab error", new Error("lab error object"));
      console.debug("lab debug");
      Promise.reject(new Error("lab rejection"));
      setTimeout(() => {
        throw new Error("lab uncaught");
      });
      this.values.console = "logged";
    },
  }));
});
