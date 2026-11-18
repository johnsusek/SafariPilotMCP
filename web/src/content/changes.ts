import type { DiffResult, DiffStartResult } from "../shared/protocol";
import { collapse } from "./describe";
import { flatParent, openModal, outsideModal } from "./flat";
import { pendingSince } from "./network";
import { refFor } from "./refs";
import {
  headOf,
  type Item,
  linesOf,
  quoted,
  rootItems,
  statesOf,
  valueOf,
} from "./tree";

// What an action changed: diffStart keeps the rendered tree read_page shows with filter all, and diff walks it again and answers what differs.
// Elements a walk looks at before the page counts as too large to diff.
export let maxElements = 20000;
// The DOM counts as settled once no mutation has come for this long.
export let quietMs = 100;
// A page still showing no change once settled is watched this long after diffStart for a later one, such as output a cross-origin frame posts back.
export let unchangedMs = 1000;
let pollMs = 20;
// A diffStart whose action never asked for its diff (the action failed before its input) stops watching after this.
let abandonMs = 60000;
// An old name or text run is cut to this in (was ...), since the new one is already on the line.
let wasMax = 80;
let old = (text: string) => JSON.stringify(collapse(text, wasMax));

// One element line of the tree, or the root (element null). value is a field's whole value, since its value= state is cut short; a secret's never leaves the frame.
type Line = {
  element: Element | null;
  item: Item | null;
  role: string;
  name: string;
  states: string[];
  value: string | null;
  texts: string[];
  children: Line[];
};

type Tree = { root: Line; nodes: Map<Element, Line> };

type Watch = {
  started: number;
  changed: number;
  before: Tree | null;
  observer: MutationObserver;
  roots: Set<Document | ShadowRoot>;
  animations: Set<Animation>;
  unveiled: Set<Element>;
  inserted: WeakSet<Node>;
  modal: Element | null;
};

let watch: Watch | null = null;

function adopt(items: Item[], parent: Line, nodes: Map<Element, Line>) {
  for (let item of items) {
    if ("text" in item) {
      parent.texts.push(item.text.trim());
      continue;
    }

    let { element, role, name } = item;
    let states = statesOf(element, role);
    let value = states.some((state) => state.startsWith("value="))
      ? valueOf(element)
      : null;
    let node: Line = {
      element,
      item,
      role,
      name,
      states,
      value,
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
  let items = rootItems(walk);

  if (walk.nodes <= 0) return null;

  let root: Line = {
    element: null,
    item: null,
    role: "",
    name: "",
    states: [],
    value: null,
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

// A MutationObserver on the document does not see into shadow roots, so every open one under root is observed too, and kept for its animations.
function observe(root: Node, state: Watch) {
  if (root === document || root instanceof ShadowRoot) {
    state.observer.observe(root, observed);
    state.roots.add(root as Document | ShadowRoot);
  }

  if (root instanceof Element && root.shadowRoot)
    observe(root.shadowRoot, state);

  if (!("querySelectorAll" in root)) return;

  for (let element of (root as ParentNode).querySelectorAll("*")) {
    if (element.shadowRoot) observe(element.shadowRoot, state);
  }
}

let animationsOf = (state: Watch) =>
  [...state.roots].flatMap((root) => root.getAnimations());

// A hidden page (the pilot window behind the user's windows) never advances its animation timeline, so an animation the action started, such as a
// dialog's exit, would never end, and a page awaiting it would stay as it was; each finite one is finished, as a shown page finishes it within its duration.
function finishStarted(state: Watch) {
  if (document.visibilityState !== "hidden") return;

  for (let animation of animationsOf(state)) {
    if (state.animations.has(animation) || animation.playState === "finished")
      continue;

    if (animation.effect?.getComputedTiming().endTime === Infinity) continue;

    state.animations.add(animation);
    animation.finish();
  }
}

function stop() {
  watch?.observer.disconnect();
  watch = null;
}

// A page that animates from script (a carousel, a progress bar) rewrites inline styles nonstop, so those alone never restart the quiet clock.
function note(records: MutationRecord[], state: Watch) {
  if (records.some((record) => record.attributeName !== "style"))
    state.changed = Date.now();

  for (let record of records) {
    for (let node of record.addedNodes) {
      observe(node, state);
      state.inserted.add(node);
    }

    if (veils.has(record.attributeName!) && !veiled(record.target as Element))
      state.unveiled.add(record.target as Element);
  }
}

export function startDiff(): DiffStartResult {
  stop();
  let started = Date.now();
  let state: Watch = {
    started,
    changed: started,
    before: snapshot(),
    observer: new MutationObserver((records) => note(records, state)),
    roots: new Set(),
    animations: new Set(),
    unveiled: new Set(),
    inserted: new WeakSet(),
    modal: openModal(),
  };

  if (state.before) {
    observe(document, state);
    state.animations = new Set(animationsOf(state));
  }

  watch = state;
  setTimeout(() => watch === state && stop(), abandonMs);
  return { ok: true, tooLarge: state.before === null };
}

type Kind = "added" | "changed" | "removed";

type Out = {
  kinds: Set<Kind>;
  // Elements back in view: under one whose aria-hidden or inert was lifted, or outside a modal dialog that closed (freed) and not inserted meanwhile.
  unveiled: Set<Element>;
  freed: Element | null;
  inserted: WeakSet<Node>;
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

// Adds a change line of a kind this pass shows under the line naming its context, which is left out for the top frame's root before anything else; once a line does not fit, every later one is omitted.
function emit(out: Out, kind: Kind, context: Line, line: string) {
  if (!out.kinds.has(kind)) return;

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
  before.value === after.value &&
  before.states.join(" ") === after.states.join(" ");

// expanded and collapsed, checked and mixed are one state each, so a flip reads as one change.
let keyOf = (state: string) =>
  ({ collapsed: "expanded", mixed: "checked" })[state] ?? state.split("=")[0];

// What differs, as it was: the old role, name and each state that changed; a value changed past its cut, or a secret's, shows its old value= state as it was.
function was(before: Line, after: Line) {
  let parts: string[] = [];

  if (before.role !== after.role) parts.push(before.role);

  if (before.name !== after.name)
    parts.push(before.name ? old(before.name) : "no name");

  let prior = new Map(before.states.map((state) => [keyOf(state), state]));
  let now = new Map(after.states.map((state) => [keyOf(state), state]));

  for (let [key, state] of now) {
    let was = prior.get(key);
    let valueChanged = key === "value" && before.value !== after.value;

    if (was === state && !valueChanged) continue;

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

// How many kept children moved, given each one's old index in its new order: all but the longest run still in old order, such as a sorted table's rows.
function movedCount(order: number[]) {
  let tails: number[] = [];

  for (let index of order) {
    let at = tails.findIndex((tail) => tail >= index);

    if (at < 0) tails.push(index);
    else tails[at] = index;
  }

  return order.length - tails.length;
}

let wordsOf = (line: Line): string[] => [
  line.name,
  ...line.texts,
  ...line.children.flatMap(wordsOf),
];

// Unnamed elements stand in for each other only when at least half their names and texts match, so a table showing other rows reads as rows removed and added.
function sharesHalf(before: Line, after: Line) {
  let left = wordsOf(before).filter(Boolean);
  let right = wordsOf(after).filter(Boolean);
  let shared = 0;

  for (let word of right) {
    let at = left.indexOf(word);

    if (at < 0) continue;

    left.splice(at, 1);
    shared++;
  }

  return shared * 2 >= Math.max(left.length + shared, right.length);
}

// aria-hidden and inert take a subtree out of the accessibility tree, as a modal does to the rest of the page.
let veils = new Set(["aria-hidden", "inert"]);
let veiled = (element: Element) =>
  element.getAttribute("aria-hidden") === "true" ||
  element.hasAttribute("inert");

let backInView = (element: Element, out: Out) =>
  underAny(element, (node) => out.unveiled.has(node)) ||
  (out.freed !== null &&
    !underAny(element, (node) => node === out.freed || out.inserted.has(node)));

let underAny = (element: Element, test: (node: Element) => boolean) => {
  for (let node: Element | null = element; node; node = flatParent(node))
    if (test(node)) return true;

  return false;
};

// after and before are one element (or the root) in the two trees. Added elements show whole with refs, removed ones only where their parent survived.
function compare(
  after: Line,
  before: Line,
  trees: { before: Tree; after: Tree },
  out: Out,
) {
  compareTexts(before.texts, after.texts, after, out);

  // A framework that renders a list again replaces its elements with equal ones; a gone child stands in for a new one with the same role and name.
  let gone = before.children.filter(
    (child) => !trees.after.nodes.has(child.element!),
  );
  let standIns = new Map<Line, Line>();

  for (let child of after.children) {
    if (trees.before.nodes.has(child.element!)) continue;

    let index = gone.findIndex(
      (old) =>
        old.role === child.role &&
        old.name === child.name &&
        (old.name !== "" || sharesHalf(old, child)),
    );

    if (index >= 0) standIns.set(child, gone.splice(index, 1)[0]);
  }

  // Equal removed lines, such as a table's unnamed rows, are counted on one. A modal hides the rest of the page with aria-hidden (Radix) or inert (react-aria), leaving it in place, so those share one line too.
  let removed = new Map<string, number>();
  let hidden = 0;

  for (let child of gone) {
    if (
      child.element!.isConnected &&
      (underAny(child.element!, veiled) || outsideModal(child.element!))
    ) {
      hidden++;
      continue;
    }

    let line = `${headOf(child.role, child.name)}${statesText(child)}`;
    removed.set(line, (removed.get(line) ?? 0) + 1);
  }

  for (let [line, count] of removed) {
    let times = count > 1 ? ` (${count} times)` : "";
    emit(out, "removed", after, `- ${line}${times}`);

    if (out.kinds.has("removed")) out.removed += count - 1;
  }

  if (hidden) {
    emit(
      out,
      "removed",
      after,
      `- ${hidden} hidden by aria-hidden, inert or a modal dialog, still in the page`,
    );

    if (out.kinds.has("removed")) out.removed += hidden - 1;
  }

  let priorOf = (child: Line) =>
    trees.before.nodes.get(child.element!) ?? standIns.get(child);
  let at = new Map(before.children.map((child, index) => [child, index]));
  let order = after.children.flatMap((child) => at.get(priorOf(child)!) ?? []);
  let moved = movedCount(order);

  if (moved)
    emit(
      out,
      "changed",
      after,
      `~ reordered: ${moved} of ${order.length} children moved`,
    );

  let shown = 0;

  for (let child of after.children) {
    let prior = priorOf(child);

    if (!prior && backInView(child.element!, out)) {
      shown++;
      continue;
    }

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

  if (!shown) return;

  emit(
    out,
    "added",
    after,
    `+ ${shown} shown again as aria-hidden, inert or a modal dialog was lifted; read_page shows them`,
  );

  if (out.kinds.has("added")) out.added += shown - 1;
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
  let watchUntil = Math.min(deadline, state.started + unchangedMs);
  let sleep = (until: number) =>
    new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(pollMs, until - Date.now()))),
    );

  while (true) {
    while (true) {
      finishStarted(state);
      let pending = pendingSince(state.started);
      result.tracked = pending !== null;
      result.pending = pending ?? 0;
      result.settled = Date.now() - state.changed >= quietMs && !result.pending;

      if (result.settled || Date.now() >= deadline) break;

      await sleep(deadline);
    }

    // Records not yet delivered still say what was unveiled.
    note(state.observer.takeRecords(), state);
    let after = snapshot();

    if (!after) {
      stop();
      return { ...result, tooLarge: true };
    }

    let trees = { before: state.before, after };
    let pass = (kinds: Kind[], out?: Out) => {
      let next: Out = out ?? {
        ...result,
        unveiled: state.unveiled,
        freed: state.modal && openModal() !== state.modal ? state.modal : null,
        inserted: state.inserted,
        lines: [],
        kinds: new Set(kinds),
        prefix,
        maxChars,
        length: 0,
        full: false,
        context: null,
      };
      next.kinds = new Set(kinds);
      next.context = null;
      compare(after.root, state.before!.root, trees, next);
      return next;
    };
    let out = pass(["added", "changed", "removed"]);

    // A diff too long to show whole lists removed lines last, so the cut drops them before new content: a modal that hides the rest of the page removes it all from view.
    if (out.omitted) out = pass(["removed"], pass(["added", "changed"]));

    let { lines, added, changed, removed, omitted } = out;

    if (added + changed + removed || Date.now() >= watchUntil) {
      stop();
      return { ...result, lines, added, changed, removed, omitted };
    }

    // Settled with nothing to show: compare again once a later mutation settles, or when the watch ends.
    let seen = state.changed;

    while (state.changed === seen && Date.now() < watchUntil) {
      await sleep(watchUntil);
      finishStarted(state);
    }
  }
}
