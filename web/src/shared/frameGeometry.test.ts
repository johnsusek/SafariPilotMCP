import { describe, expect, test } from "vitest";
import { descend, toLocal, toTop, topView } from "./frameGeometry";

describe("frame geometry", () => {
  test("descend offsets by the box and intersects clips", () => {
    let outer = descend(
      topView({ left: 0, top: 0, width: 1000, height: 800 }),
      {
        box: { left: 10, top: 600, width: 400, height: 300 },
        clip: { left: 10, top: 600, width: 400, height: 200 },
      },
    );
    expect(outer).toEqual({
      offset: { left: 10, top: 600 },
      clip: { left: 10, top: 600, width: 400, height: 200 },
    });
    let inner = descend(outer, {
      box: { left: 20, top: 150, width: 100, height: 100 },
      clip: { left: 20, top: 150, width: 100, height: 100 },
    });
    expect(inner).toEqual({
      offset: { left: 30, top: 750 },
      clip: { left: 30, top: 750, width: 100, height: 50 },
    });
    expect(
      descend(inner, {
        box: { left: 0, top: 0, width: 5, height: 5 },
        clip: null,
      }).clip,
    ).toBeNull();
  });

  test("toTop and toLocal are inverses that keep other fields", () => {
    let view = { offset: { left: 30, top: 750 }, clip: null };
    let rect = { left: 1, top: 2, width: 3, height: 4 };
    expect(toTop(rect, view)).toEqual({
      left: 31,
      top: 752,
      width: 3,
      height: 4,
    });
    expect(toLocal(toTop(rect, view), view)).toEqual(rect);
  });
});
