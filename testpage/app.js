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

function detailOf(event) {
  if (event instanceof MouseEvent)
    return `b${event.button} ${event.clientX},${event.clientY}`;
  if (event instanceof KeyboardEvent) return event.key;
  if (event instanceof InputEvent) return event.inputType;
  return "";
}

document.addEventListener("alpine:init", () => {
  Alpine.data("lab", () => ({
    counts: Object.fromEntries(counterNames.map((name) => [name, 0])),
    values: { text: "", textarea: "", select: "One", time: "", date: "" },
    log: [],

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

    bump(name) {
      this.counts[name]++;
    },

    reset() {
      for (let name of counterNames) this.counts[name] = 0;
      this.log = [];
    },

    synthetic() {
      document.getElementById("native").click();
    },
  }));
});
