import type { DiffResult, DiffStartResult } from "../shared/protocol";
import { hidden } from "../shared/redact";
import { collapse } from "./describe";
import { pendingSince } from "./network";
import { refFor } from "./refs";
import {
  build,
  headOf,
  type Item,
  linesOf,
  quoted,
  statesOf,
  valueOf,
} from "./tree";

// What an action changed: diffStart keeps the rendered tree read_page shows with filter all, and diff walks it again and answers what differs.
// Elements a walk looks at before the page counts as too large to diff.
export let maxElements = 20000;
// The DOM counts as settled once no mutation has come for this long.
export let quietMs = 100;
let pollMs = 20;
// A diffStart whose action never asked for its diff (the action failed before its input) stops watching after this.
let abandonMs = 60000;
// An old name or text run is cut to this in (was ...), since the new one is already on the line.
let wasMax = 80;
let old = (text: string) => JSON.stringify(collapse(text, wasMax));

// One element line of the tree, or the root (element null). secret is a secret field's value, kept only to notice it changed; it never leaves the frame.
type Line = {
  element: Element | null;
  item: Item | null;
  role: string;
  name: string;
  states: string[];
  secret: string | null;
  texts: string[];
  children: Line[];
};

type Tree = { root: Line; nodes: Map<Element, Line> };

type Watch = {
  started: number;
  changed: number;
  before: Tree | null;
  observer: MutationObserver;
};

let watch: Watch | null = null;

function adopt(items: Item[], parent: Line, nodes: Map<Element, Line>) {
  for (let item of items) {
    if ("text" in item) {
      parent.texts.push(item.text);
      continue;
    }

    let { element, role, name } = item;
    let states = statesOf(element, role);
    let secret = states.includes(`value=${hidden}`) ? valueOf(element) : null;
    let node: Line = {
      element,
      item,
      role,
      name,
      states,
      secret,
      texts: [],
      children: [],
    };
    nodes.set(element, node);
    parent.children.push(node);
    adopt(item.children, node, nodes);
  }
}

// The rendered tree, or null when the page has more than maxElements elements.
function snapshot(): Tree | null {
  let walk = { interactiveOnly: false, left: Infinity, nodes: maxElements };
  let items = build(document.body ?? document.documentElement, walk);

  if (walk.nodes <= 0) return null;

  let root: Line = {
    element: null,
    item: null,
    role: "",
    name: "",
    states: [],
    secret: null,
    texts: [],
    children: [],
  };
  let tree = { root, nodes: new Map<Element, Line>() };
  adopt(items, tree.root, tree.nodes);
  return tree;
}

let observed = {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true,
};

// A MutationObserver on the document does not see into shadow roots, so every open one under root is observed too.
function observe(root: Node, observer: MutationObserver) {
  if (root === document || root instanceof ShadowRoot)
    observer.observe(root, observed);

  if (root instanceof Element && root.shadowRoot)
    observe(root.shadowRoot, observer);

  if (!("querySelectorAll" in root)) return;

  for (let element of (root as ParentNode).querySelectorAll("*")) {
    if (element.shadowRoot) observe(element.shadowRoot, observer);
  }
}

function stop() {
  watch?.observer.disconnect();
  watch = null;
}

export function startDiff(): DiffStartResult {
  stop();
  let started = Date.now();
  let state: Watch = {
    started,
    changed: started,
    before: snapshot(),
    observer: new MutationObserver((records) => {
      // A page that animates from script (a carousel, a progress bar) rewrites inline styles nonstop, so those alone never restart the quiet clock.
      if (records.some((record) => record.attributeName !== "style"))
        state.changed = Date.now();

      for (let record of records) {
        for (let node of record.addedNodes) observe(node, state.observer);
      }
    }),
  };

  if (state.before) observe(document, state.observer);

  watch = state;
  setTimeout(() => watch === state && stop(), abandonMs);
  return { ok: true, tooLarge: state.before === null };
}

type Out = {
  prefix: string;
  maxChars: number;
  lines: string[];
  length: number;
  full: boolean;
  context: Line | null;
  added: number;
  changed: number;
  removed: number;
  omitted: number;
};

let header = (node: Line, out: Out) =>
  node.element
    ? `in ${headOf(node.role, node.name)} [ref=${out.prefix}${refFor(node.element)}]:`
    : out.prefix
      ? `in iframe ${out.prefix.slice(0, -1)}:`
      : "in page:";

// Adds a change line under the line naming its context, which is left out for the top frame's root before anything else; once a line does not fit, every later one is omitted.
function emit(
  out: Out,
  kind: "added" | "changed" | "removed",
  context: Line,
  line: string,
) {
  out[kind]++;
  let lines =
    context === out.context ||
    (!context.element && !out.prefix && !out.lines.length)
      ? [line]
      : [header(context, out), line];
  let length =
    out.length + lines.reduce((sum, text) => sum + text.length + 1, 0);

  if (out.full || length - 1 > out.maxChars) {
    out.full = true;
    out.omitted++;
    return;
  }

  out.lines.push(...lines);
  out.length = length;
  out.context = context;
}

let statesText = (node: Line) =>
  node.states.map((state) => ` ${state}`).join("");

let same = (before: Line, after: Line) =>
  before.role === after.role &&
  before.name === after.name &&
  before.secret === after.secret &&
  before.states.join(" ") === after.states.join(" ");

// expanded and collapsed, checked and mixed are one state each, so a flip reads as one change.
let keyOf = (state: string) =>
  ({ collapsed: "expanded", mixed: "checked" })[state] ?? state.split("=")[0];

// What differs, as it was: the old role, name and each state that changed; a secret field's old value shows as value=[hidden] like its new one.
function was(before: Line, after: Line) {
  let parts: string[] = [];

  if (before.role !== after.role) parts.push(before.role);

  if (before.name !== after.name)
    parts.push(before.name ? old(before.name) : "no name");

  let prior = new Map(before.states.map((state) => [keyOf(state), state]));
  let now = new Map(after.states.map((state) => [keyOf(state), state]));

  for (let [key, state] of now) {
    let was = prior.get(key);
    let secretChanged = key === "value" && before.secret !== after.secret;

    if (was === state && !secretChanged) continue;

    parts.push(was ?? (state.includes("=") ? `no ${key}` : `not ${state}`));
  }

  for (let [key, state] of prior) {
    if (!now.has(key)) parts.push(state);
  }

  return parts.join(", ");
}

// Text runs at the same places are compared one by one; otherwise runs not found in the other list are added or removed.
function compareTexts(
  before: string[],
  after: string[],
  context: Line,
  out: Out,
) {
  if (before.length === after.length) {
    for (let [index, text] of after.entries()) {
      if (text !== before[index])
        emit(
          out,
          "changed",
          context,
          `~ ${quoted(text)} (was ${old(before[index])})`,
        );
    }

    return;
  }

  let left = [...before];

  for (let text of after) {
    let at = left.indexOf(text);

    if (at >= 0) left.splice(at, 1);
    else emit(out, "added", context, `+ ${quoted(text)}`);
  }

  for (let text of left) emit(out, "removed", context, `- ${quoted(text)}`);
}

// after and before are one element (or the root) in the two trees. Added elements show whole with refs, removed ones only where their parent survived.
function compare(
  after: Line,
  before: Line,
  trees: { before: Tree; after: Tree },
  out: Out,
) {
  compareTexts(before.texts, after.texts, after, out);

  for (let child of before.children) {
    if (!trees.after.nodes.has(child.element!))
      emit(
        out,
        "removed",
        after,
        `- ${headOf(child.role, child.name)}${statesText(child)}`,
      );
  }

  for (let child of after.children) {
    let prior = trees.before.nodes.get(child.element!);

    if (!prior) {
      for (let line of linesOf([child.item!], out.prefix))
        emit(out, "added", after, `+ ${line}`);

      continue;
    }

    if (!same(prior, child))
      emit(
        out,
        "changed",
        after,
        `~ ${headOf(child.role, child.name)} [ref=${out.prefix}${refFor(child.element!)}]${statesText(child)} (was ${was(prior, child)})`,
      );

    compare(child, prior, trees, out);
  }
}

export async function takeDiff(
  prefix: string,
  waitMs: number,
  maxChars: number,
): Promise<DiffResult> {
  let state = watch;
  let result = {
    ok: true as const,
    started: state !== null,
    tooLarge: state?.before === null,
    lines: [] as string[],
    added: 0,
    changed: 0,
    removed: 0,
    omitted: 0,
    tracked: true,
    pending: 0,
    settled: true,
  };

  if (!state?.before) {
    stop();
    return result;
  }

  let deadline = Date.now() + waitMs;

  while (true) {
    let pending = pendingSince(state.started);
    result.tracked = pending !== null;
    result.pending = pending ?? 0;
    result.settled = Date.now() - state.changed >= quietMs && !result.pending;

    if (result.settled || Date.now() >= deadline) break;

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollMs, deadline - Date.now())),
    );
  }

  stop();
  let after = snapshot();

  if (!after) return { ...result, tooLarge: true };

  let out: Out = {
    ...result,
    prefix,
    maxChars,
    length: 0,
    full: false,
    context: null,
  };
  compare(after.root, state.before.root, { before: state.before, after }, out);
  let { lines, added, changed, removed, omitted } = out;
  return { ...result, lines, added, changed, removed, omitted };
}
