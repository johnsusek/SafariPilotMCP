import type { Failure, InspectResult } from "../shared/protocol";
import { resolveRef } from "./refs";

export function inspect(ref: number): InspectResult | Failure {
  let element = resolveRef(ref);
  if (!(element instanceof Element)) return element;
  let hover = element.matches(":hover");

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  )
    return { ok: true, ref, hover, value: element.value };

  if (element instanceof HTMLElement && element.isContentEditable)
    return { ok: true, ref, hover, value: element.textContent ?? "" };
  return { ok: true, ref, hover, value: null };
}
