import { intersect } from "../content/geometry";
import type { FrameEntry, Point, Rect } from "./protocol";

// Where a frame's document sits in top-frame CSS px: offset is the origin of its viewport and clip the part of it the user can see, null when none.
export type FrameView = { offset: Point; clip: Rect | null };

export let topView = (visible: Rect): FrameView => ({
  offset: { left: 0, top: 0 },
  clip: visible,
});

export let toTop = <Shape extends Point>(
  shape: Shape,
  view: FrameView,
): Shape => ({
  ...shape,
  left: shape.left + view.offset.left,
  top: shape.top + view.offset.top,
});

export let toLocal = <Shape extends Point>(
  shape: Shape,
  view: FrameView,
): Shape => ({
  ...shape,
  left: shape.left - view.offset.left,
  top: shape.top - view.offset.top,
});

// The view of the frame inside an iframe of the document seen through view; transformed frames are refused elsewhere, so this is a pure translation.
export function descend(
  view: FrameView,
  frame: Pick<FrameEntry, "box" | "clip">,
): FrameView {
  let box = toTop(frame.box, view);
  let clip =
    frame.clip && view.clip
      ? intersect(toTop(frame.clip, view), view.clip)
      : null;
  return { offset: { left: box.left, top: box.top }, clip };
}
