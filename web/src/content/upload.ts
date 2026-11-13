import type { Failure, UploadFile, UploadResult } from "../shared/protocol";
import { describe } from "./describe";
import { flatChildren } from "./flat";
import { deepElementFromPoint, isWithin } from "./hit";
import { refFor, resolveRef } from "./refs";

let isFileInput = (node: unknown): node is HTMLInputElement =>
  node instanceof HTMLInputElement && node.type === "file";

// Hidden ones included, since uploaders usually hide the input behind a button or a drop zone.
function* fileInputs(root: Node): Generator<HTMLInputElement> {
  for (let child of flatChildren(root)) {
    if (isFileInput(child)) yield child;

    yield* fileInputs(child);
  }
}

let listed = (inputs: HTMLInputElement[]) =>
  inputs.map((input) => `[ref=${refFor(input)}] ${describe(input)}`).join(", ");

let shown = (files: FileList) =>
  Array.from(files, (file) => ({
    name: file.name,
    size: file.size,
    type: file.type,
  }));

function setInput(
  ref: number,
  input: HTMLInputElement,
  transfer: DataTransfer,
): UploadResult | Failure {
  let count = transfer.files.length;

  if (input.disabled)
    return { ok: false, error: `${describe(input)} is disabled` };

  if (count > 1 && !input.multiple)
    return {
      ok: false,
      error: `${describe(input)} takes one file (it has no multiple attribute) and ${count} were given; nothing was set`,
    };

  input.files = transfer.files;
  let taken = Array.from(input.files ?? [], (file) => file.name);
  let wanted = Array.from(transfer.files, (file) => file.name);

  if (taken.join("/") !== wanted.join("/"))
    return {
      ok: false,
      error: `${describe(input)} holds ${JSON.stringify(taken)} after assigning ${JSON.stringify(wanted)}`,
    };

  // As after a pick in the file panel: input bubbles and is composed, change bubbles.
  let dispatched = ["input", "change"].map((type) => ({
    type,
    canceled: !input.dispatchEvent(
      new Event(type, { bubbles: true, composed: type === "input" }),
    ),
  }));
  return {
    ok: true,
    ref,
    target: describe(input),
    via: "input",
    files: shown(input.files!),
    dispatched,
  };
}

// A real drop happens only when a dragover listener canceled the event; otherwise the drag leaves without dropping, and the page's file inputs are named instead.
function drop(
  ref: number,
  element: Element,
  transfer: DataTransfer,
): UploadResult | Failure {
  let rect = element.getBoundingClientRect();
  let point = {
    left: rect.left + rect.width / 2,
    top: rect.top + rect.height / 2,
  };
  let hit = deepElementFromPoint(point);
  let target = hit && isWithin(element, hit) ? hit : element;
  let dispatched: UploadResult["dispatched"] = [];
  let fire = (type: string) => {
    let event = new DragEvent(type, {
      bubbles: true,
      cancelable: type !== "dragleave",
      composed: true,
      view: window,
      clientX: point.left,
      clientY: point.top,
      dataTransfer: transfer,
    });
    let canceled = !target.dispatchEvent(event);
    dispatched.push({ type, canceled });
    return canceled;
  };

  fire("dragenter");

  if (!fire("dragover")) {
    fire("dragleave");
    let inputs = [...fileInputs(document)];
    let hint = inputs.length
      ? `; this frame's file inputs: ${listed(inputs)}`
      : "; this frame has no file input";
    return {
      ok: false,
      error: `${describe(target)} did not accept a drop (no dragover listener called preventDefault), so nothing was dropped${hint}`,
    };
  }

  fire("drop");
  return {
    ok: true,
    ref,
    target: describe(target),
    via: "drop",
    files: shown(transfer.files),
    dispatched,
  };
}

// Safari's open panel cannot be driven in the background, so the page gets File objects directly: a file input ref, a label for one,
// or an element holding exactly one takes them through a DataTransfer; anything else, such as a drop zone, gets a synthetic drop.
export function upload(
  ref: number,
  files: UploadFile[],
): UploadResult | Failure {
  let element = resolveRef(ref);
  if (!(element instanceof Element)) return element;

  if (element instanceof HTMLIFrameElement)
    return {
      ok: false,
      error: `${describe(element)} is an iframe; pass the ref of the file input or drop zone inside its frame, such as ${ref}:12`,
    };

  let transfer = new DataTransfer();

  for (let file of files)
    transfer.items.add(
      new File([Uint8Array.fromBase64(file.data)], file.name, {
        type: file.mimeType,
        lastModified: file.lastModified,
      }),
    );

  if (isFileInput(element)) return setInput(ref, element, transfer);

  let control = (element as HTMLLabelElement).control;

  if (isFileInput(control)) return setInput(ref, control, transfer);

  let inside = [...fileInputs(element)];

  if (inside.length === 1) return setInput(ref, inside[0], transfer);

  if (inside.length > 1)
    return {
      ok: false,
      error: `${describe(element)} holds ${inside.length} file inputs, so pass the ref of one: ${listed(inside)}`,
    };

  return drop(ref, element, transfer);
}
