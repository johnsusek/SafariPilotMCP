import { describe, expect, test } from "vitest";
import { candidatePoints, intersect, pickPoint } from "./geometry";

let viewport = { left: 0, top: 0, width: 1000, height: 800 };

describe("intersect", () => {
  test("overlap and disjoint", () => {
    expect(
      intersect({ left: 900, top: 700, width: 200, height: 200 }, viewport),
    ).toEqual({ left: 900, top: 700, width: 100, height: 100 });
    expect(
      intersect({ left: 1200, top: 0, width: 50, height: 50 }, viewport),
    ).toBeNull();
  });
});

describe("pickPoint", () => {
  let rect = { left: 100, top: 100, width: 200, height: 40 };

  test("center first", () => {
    expect(pickPoint(rect, rect, () => true)).toEqual({ left: 200, top: 120 });
  });

  test("falls back to an uncovered sample", () => {
    // Left 60% of the button is covered.
    let point = pickPoint(rect, rect, (candidate) => candidate.left > 220);
    expect(point).not.toBeNull();
    expect(point!.left).toBeGreaterThan(220);
    expect(point!.left).toBeLessThanOrEqual(298);
  });

  test("null when every sample is covered", () => {
    expect(pickPoint(rect, rect, () => false)).toBeNull();
  });

  test("center is clamped into a partially visible clip", () => {
    let tall = { left: 0, top: 700, width: 100, height: 400 };
    let clip = intersect(tall, viewport)!;
    let [center] = candidatePoints(tall, clip);
    expect(center).toEqual({ left: 50, top: 798 });
    for (let point of candidatePoints(tall, clip))
      expect(point.top).toBeLessThan(800);
  });

  test("tiny elements stay inside their box", () => {
    let tiny = { left: 10, top: 10, width: 2, height: 2 };
    for (let point of candidatePoints(tiny, tiny)) {
      expect(point.left).toBeGreaterThanOrEqual(10);
      expect(point.left).toBeLessThanOrEqual(12);
    }
  });
});
