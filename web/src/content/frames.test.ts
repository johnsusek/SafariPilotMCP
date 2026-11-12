// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { frameBox, frameEntry, hitFrame, sourceOf } from "./frames";
import { locate } from "./locate";
import { refFor } from "./refs";

let rect = (left: number, top: number, width: number, height: number) =>
  new DOMRect(left, top, width, height);

let layout = (
  element: Element,
  box: DOMRect,
  size: Record<string, number> = {},
) => {
  element.getBoundingClientRect = () => box;

  for (let [name, value] of Object.entries(size))
    Object.defineProperty(element, name, { value, configurable: true });
};

beforeEach(() => {
  vi.stubGlobal("browser", { runtime: { getFrameId: () => 77 } });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: { scale: 1, offsetLeft: 0, offsetTop: 0, width: 1000, height: 800 },
  });
});

afterEach(() => vi.unstubAllGlobals());

let iframeAt = (style = "") => {
  document.body.innerHTML = `<iframe style="${style}"></iframe>`;
  let iframe = document.querySelector("iframe")!;
  layout(iframe, rect(100, 700, 404, 304), {
    clientLeft: 2,
    clientTop: 2,
    clientWidth: 400,
    clientHeight: 300,
    offsetWidth: 404,
    offsetHeight: 304,
  });
  return iframe;
};

describe("frameEntry", () => {
  test("content box inside border and padding, clipped to the viewport", () => {
    let entry = frameEntry(iframeAt("padding: 4px"));
    expect(entry).toMatchObject({
      frameId: 77,
      box: { left: 106, top: 706, width: 392, height: 292 },
      clip: { left: 106, top: 706, width: 392, height: 94 },
      transformed: false,
      sandbox: null,
    });
  });

  test("any transform, or a scaled box, counts as transformed", () => {
    expect(frameEntry(iframeAt("transform: scale(0.5)")).transformed).toBe(
      true,
    );
    let scaled = iframeAt();
    layout(scaled, rect(100, 700, 202, 152));
    expect(frameEntry(scaled).transformed).toBe(true);
  });

  test("identity transforms and whole-pixel offset sizes are not transformed", () => {
    for (let style of ["translate: 0px", "scale: 1", "rotate: 0deg"])
      expect(frameEntry(iframeAt(style)).transformed).toBe(false);

    expect(frameEntry(iframeAt("translate: 0px 4px")).transformed).toBe(true);
    let fractional = iframeAt();
    layout(fractional, rect(100, 700, 20.5, 20.5), {
      offsetWidth: 21,
      offsetHeight: 21,
    });
    expect(frameEntry(fractional).transformed).toBe(false);
  });

  test("an iframe that cannot move is not reported as moved", () => {
    let iframe = iframeAt();
    layout(iframe, rect(0, -100, 1004, 1004));
    iframe.scrollIntoView = vi.fn();
    expect(frameBox(refFor(iframe), true)).toMatchObject({ moved: false });
    expect(iframe.scrollIntoView).toHaveBeenCalled();
  });

  test("inline sources are named by their scheme", () => {
    let iframe = iframeAt();
    iframe.src = "data:text/html;base64,PGgxPmhpPC9oMT4=";
    expect(sourceOf(iframe)).toBe("data:");
    iframe.src = "https://a.test/page";
    expect(sourceOf(iframe)).toBe("https://a.test/page");
  });

  test("frameBox reveals a partly hidden iframe, hitFrame tests points against it", () => {
    let iframe = iframeAt();
    iframe.scrollIntoView = vi.fn(() =>
      layout(iframe, rect(100, 400, 404, 304)),
    );
    let ref = refFor(iframe);
    expect(frameBox(ref, true)).toMatchObject({ ok: true, moved: true });
    expect(iframe.scrollIntoView).toHaveBeenCalled();
    document.elementFromPoint = (left: number) =>
      left > 150 ? iframe : document.body;
    expect(
      hitFrame(ref, [
        { left: 120, top: 750 },
        { left: 200, top: 750 },
      ]),
    ).toEqual({
      ok: true,
      hits: [false, true],
      hitDescription: "body",
    });
    expect(frameBox(refFor(document.body), false)).toEqual({
      ok: false,
      error: expect.stringMatching(/is a <body>, not an iframe/),
    });
  });
});

describe("locate with a clip", () => {
  test("lists only points inside the clip that hit the element", async () => {
    document.body.innerHTML = "<button>Go</button>";
    let button = document.querySelector("button")!;
    layout(button, rect(0, 0, 100, 40));
    document.elementFromPoint = () => button;
    let located = await locate(
      refFor(button),
      { left: 50, top: 0, width: 100, height: 100 },
      false,
    );
    expect(located).toMatchObject({ ok: true, hitsTarget: true });
    let candidates = located.ok
      ? (located as { candidates: { left: number }[] }).candidates
      : [];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(8);
    expect(candidates.every((point) => point.left >= 50)).toBe(true);
    let hidden = await locate(
      refFor(button),
      { left: 200, top: 0, width: 100, height: 100 },
      false,
    );
    expect(hidden).toMatchObject({
      hitsTarget: false,
      hitDescription: "element is outside the viewport",
    });
  });
});
