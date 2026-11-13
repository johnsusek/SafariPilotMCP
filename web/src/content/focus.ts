import type { Failure, FocusResult } from "../shared/protocol";
import { describe } from "./describe";
import { flatParent } from "./flat";
import { resolveRef } from "./refs";

// Focuses ref, or its nearest ancestor that takes focus, from the page: setting AXFocused instead makes a background Safari ask to come forward.
export function focusRef(ref: number): FocusResult | Failure {
  let element = resolveRef(ref);
  if (!(element instanceof Element)) return element;

  let active = () => {
    let found = document.activeElement;
    while (found?.shadowRoot?.activeElement)
      found = found.shadowRoot.activeElement;
    return found;
  };

  for (
    let candidate: Element | null = element;
    candidate;
    candidate = flatParent(candidate)
  ) {
    if (!(candidate instanceof HTMLElement || candidate instanceof SVGElement))
      continue;

    candidate.focus({ preventScroll: true });
    if (active() === candidate)
      return { ok: true, ref, focused: describe(candidate) };
  }

  return {
    ok: false,
    error: `ref ${ref} ${describe(element)} and its ancestors do not take focus`,
  };
}
