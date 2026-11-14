// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { drag } from "./drag";
import { refFor } from "./refs";

// happy-dom has no DragEvent; Safari's carries init.dataTransfer as dataTransfer.
(window as unknown as { DragEvent: unknown }).DragEvent = function (
  type: string,
  init: MouseEventInit & { dataTransfer: DataTransfer },
) {
  let event = new MouseEvent(type, init);
  Object.defineProperty(event, "dataTransfer", { value: init.dataTransfer });
  return event;
};

// happy-dom has no draggable property; Safari's is true for draggable="true", links with href and images.
Object.defineProperty(HTMLElement.prototype, "draggable", {
  get() {
    return this.getAttribute("draggable") === "true";
  },
});

// Laid out in a row: src at 0-100, gap between, zone at 200-300, plain at 400-500; covered hides zone.
let columns: [number, string][] = [
  [0, "src"],
  [100, "gap"],
  [200, "zone"],
  [300, "gap"],
  [400, "plain"],
  [500, "gap"],
];
let covered = false;
let element = (id: string) => document.getElementById(id)!;

beforeEach(() => {
  covered = false;
  document.body.innerHTML =
    '<div id="gap"><span id="src" draggable="true">Card</span><div id="zone">Zone</div><div id="plain">Plain</div></div>';

  for (let [left, id] of columns.filter(([, id]) => id !== "gap"))
    element(id).getBoundingClientRect = () =>
      ({ left, top: 0, width: 100, height: 50 }) as DOMRect;

  document.elementFromPoint = (left: number) => {
    let id = [...columns].reverse().find(([start]) => left >= start)![1];
    return covered && id === "zone" ? element("gap") : element(id);
  };
});

let run = (from: string, to: string) =>
  drag(refFor(element(from)), refFor(element(to)));
let types = (result: Awaited<ReturnType<typeof drag>>) => {
  if (!result.ok) throw new Error(result.error);

  return result.dispatched.map(
    ({ type, count, canceled }) =>
      `${type}${count > 1 ? ` x${count}` : ""}${canceled ? " canceled" : ""}`,
  );
};

describe("drag", () => {
  test("a draggable source runs an HTML5 drag that drops where dragover was canceled", async () => {
    let dropped = "";
    element("src").addEventListener("dragstart", (event) =>
      event.dataTransfer!.setData("text/plain", "card"),
    );
    element("zone").addEventListener("dragover", (event) =>
      event.preventDefault(),
    );
    element("zone").addEventListener("drop", (event) => {
      dropped = event.dataTransfer!.getData("text/plain");
      event.preventDefault();
    });
    let result = await run("src", "zone");
    // Steps at x 70 and 90 are over src, 110 to 190 over the gap and 210 to 250 over zone.
    let over = (count: number, canceled = "") =>
      Array.from({ length: count }, () => [
        "drag",
        `dragover${canceled}`,
      ]).flat();
    expect(types(result)).toEqual([
      "pointerdown",
      "mousedown",
      "pointermove",
      "mousemove",
      "dragstart",
      "pointercancel",
      "drag",
      "dragenter",
      "dragover",
      ...over(1),
      "drag",
      "dragenter",
      "dragleave",
      "dragover",
      ...over(4),
      "drag",
      "dragenter",
      "dragleave",
      "dragover canceled",
      ...over(2, " canceled"),
      "drop canceled",
      "dragend",
    ]);
    expect(result).toMatchObject({
      ok: true,
      html5: true,
      dropped: true,
      source: expect.stringContaining("span#src"),
      target: expect.stringContaining("div#zone"),
    });
    expect(dropped).toBe("card");
  });

  test("an HTML5 drag nobody accepts leaves without dropping", async () => {
    let result = await run("src", "zone");
    expect(types(result).slice(-2)).toEqual(["dragleave", "dragend"]);
    expect(result).toMatchObject({ html5: true, dropped: false });
  });

  test("a canceled dragstart leaves a pointer drag ending in pointerup, mouseup and click", async () => {
    element("src").addEventListener("dragstart", (event) =>
      event.preventDefault(),
    );
    let result = await run("src", "zone");
    expect(types(result)).toContain("dragstart canceled");
    expect(types(result)).not.toContain("pointercancel");
    expect(types(result).slice(-3)).toEqual(["pointerup", "mouseup", "click"]);
    expect(result).toMatchObject({ html5: false, dropped: false });
  });

  test("a plain source sends moves with over, out, enter and leave, and clicks the common ancestor", async () => {
    let seen: string[] = [];

    for (let type of ["mouseenter", "mouseleave", "pointerup", "click"])
      document.addEventListener(
        type,
        (event) => seen.push(`${type} ${(event.target as Element).id}`),
        true,
      );

    let moves: number[] = [];
    document.addEventListener("pointermove", (event) =>
      moves.push(event.clientX),
    );
    let result = await run("plain", "zone");
    expect(result).toMatchObject({
      html5: false,
      target: expect.stringContaining("div#zone"),
    });
    expect(moves).toHaveLength(10);
    expect(moves.at(-1)).toBe(250);
    expect(seen).toEqual([
      "mouseleave plain",
      "mouseenter zone",
      "pointerup zone",
      "click gap",
    ]);
    expect(
      (result as { dispatched: { type: string }[] }).dispatched[0],
    ).toEqual({ type: "pointerdown", canceled: false, count: 1 });
  });

  test("a canceled pointerdown silences mouse events but still clicks", async () => {
    element("plain").addEventListener("pointerdown", (event) =>
      event.preventDefault(),
    );
    let result = await run("plain", "zone");
    expect(types(result).some((type) => type.startsWith("mouse"))).toBe(false);
    expect(types(result).slice(-2)).toEqual(["pointerup", "click"]);
  });

  test("a canceled mousedown keeps a draggable source from starting an HTML5 drag", async () => {
    element("src").addEventListener("mousedown", (event) =>
      event.preventDefault(),
    );
    let result = await run("src", "zone");
    expect(types(result)).not.toContain("dragstart");
    expect(result).toMatchObject({ html5: false });
  });

  test("a covered target sends nothing", async () => {
    covered = true;
    let fired = false;
    document.addEventListener("pointerdown", () => (fired = true));
    expect(await run("src", "zone")).toMatchObject({
      ok: false,
      code: "not_actionable",
    });
    expect(fired).toBe(false);
  });
});
