// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import { existingRef, refFor, resolveRef } from "./refs";

describe("refs", () => {
  test("same element keeps its ref", () => {
    let button = document.createElement("button");
    document.body.append(button);
    let ref = refFor(button);
    expect(refFor(button)).toBe(ref);
    expect(refFor(document.createElement("a"))).not.toBe(ref);
    expect(resolveRef(ref)).toBe(button);
  });

  test("each document numbers its refs from a random thousand", async () => {
    vi.resetModules();
    vi.spyOn(Math, "random").mockReturnValue(0.4829);
    let fresh = await import("./refs");
    vi.restoreAllMocks();
    let first = document.createElement("button");
    let second = document.createElement("button");
    expect([fresh.refFor(first), fresh.refFor(second)]).toEqual([
      482001, 482002,
    ]);
  });

  test("existingRef never allocates", () => {
    let span = document.createElement("span");
    expect(existingRef(span)).toBeNull();
    expect(existingRef(span)).toBeNull();
    let ref = refFor(span);
    expect(existingRef(span)).toBe(ref);
  });

  test("detached and unknown refs fail", () => {
    let button = document.createElement("button");
    document.body.append(button);
    let ref = refFor(button);
    button.remove();
    expect(resolveRef(ref)).toEqual({
      ok: false,
      error: `ref ${ref} is detached from the document`,
      code: "stale_ref",
    });
    expect(resolveRef(99999)).toEqual({
      ok: false,
      error: "ref 99999 is unknown",
      code: "stale_ref",
    });
  });
});
