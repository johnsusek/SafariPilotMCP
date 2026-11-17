import { visibleArea } from "../content/geometry";
import type { PageLocateResult, RefPath } from "../shared/commands";
import {
  descend,
  type FrameView,
  toLocal,
  toTop,
  topView,
} from "../shared/frameGeometry";
import type {
  ContentRequest,
  ContentResponse,
  Failure,
  FrameBoxResult,
  FrameEntry,
  FramesResult,
  HitFrameResult,
  LocateResult,
  Rect,
  Viewport,
} from "../shared/protocol";

export let frameTimeoutMs = 2000;
export let maxFrameDepth = 3;
export let maxFrames = 20;
// Smaller frames are tracking pixels, not content.
export let minFrameSize = 16;

export type Send = (
  frameId: number,
  request: ContentRequest,
) => Promise<ContentResponse>;

export type Path = { frames: number[]; local: number };

// Thrown, so a failure reaches runPage or runCommand through any code with its code kept; failureFrom turns it back into the Failure.
export let thrown = (failure: Failure) =>
  Object.assign(new Error(failure.error), { failure });

export let failureFrom = (error: unknown) =>
  (error as { failure?: Failure } | null)?.failure ?? null;

export function parsePath(ref: RefPath): Path {
  if (!/^\d+(:\d+){0,3}$/.test(ref))
    throw thrown({
      ok: false,
      error: `ref ${JSON.stringify(ref)} must look like 12, or 5:12 for ref 12 inside the frame of iframe 5, at most ${maxFrameDepth} frames deep`,
      code: "invalid_argument",
    });

  let parts = ref.split(":").map(Number);
  return { frames: parts.slice(0, -1), local: parts.at(-1)! };
}

// Answers with a failure once ms pass, so a busy page cannot hold the background's only poll; what was sent may still run, so it is timed_out.
export async function withTimeout<Answer>(
  answer: Promise<Answer>,
  ms: number,
  error: string,
): Promise<Answer | Failure> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeout = new Promise<Failure>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error, code: "timed_out" }),
      ms,
    );
  });

  try {
    return await Promise.race([answer, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// One stuck frame must not hold up a read of the whole page.
export let timed = (send: Send, frameId: number, request: ContentRequest) =>
  withTimeout(
    send(frameId, request),
    frameTimeoutMs,
    `no answer within ${frameTimeoutMs} ms`,
  );

export let allowsScripts = (sandbox: string | null) =>
  sandbox === null ||
  sandbox.toLowerCase().split(/\s+/).includes("allow-scripts");

// A hop is one iframe on the way down: frameId and view are those of the document holding it, origin that document's timeOrigin.
export type Hop = {
  ref: number;
  path: RefPath;
  frameId: number;
  view: FrameView;
  origin: number;
};

export type Walk = {
  frameId: number;
  view: FrameView;
  viewport: Viewport;
  hops: Hop[];
  moved: boolean;
  sandboxed: boolean;
  transformed: boolean;
};

// Follows iframe refs down from the top frame to the frame that owns a path's element; reveal scrolls each iframe into view on the way.
export async function walkPath(
  send: Send,
  frames: number[],
  reveal: boolean,
): Promise<Walk> {
  let walk: Walk = {
    frameId: 0,
    view: topView({ left: 0, top: 0, width: 0, height: 0 }),
    viewport: undefined as unknown as Viewport,
    hops: [],
    moved: false,
    sandboxed: false,
    transformed: false,
  };

  for (let [index, ref] of frames.entries()) {
    let path = frames.slice(0, index + 1).join(":");
    let reply = await send(walk.frameId, { op: "frameBox", ref, reveal });

    if (!reply.ok)
      throw thrown({
        ...reply,
        error:
          index === 0
            ? reply.error
            : `in the frame of iframe ${frames.slice(0, index).join(":")}: ${reply.error}`,
      });

    let { frame, viewport, moved, origin } = reply as FrameBoxResult;

    if (index === 0) {
      walk.viewport = viewport;
      walk.view = topView(visibleArea(viewport));
    }

    walk.hops.push({
      ref,
      path,
      frameId: walk.frameId,
      view: walk.view,
      origin,
    });

    if (frame.frameId < 0)
      throw thrown({
        ok: false,
        error: `iframe ${path} has no frame yet; scroll_to ${path} to load it, then retry`,
        code: "not_actionable",
      });

    walk.moved ||= moved;
    walk.sandboxed ||= !allowsScripts(frame.sandbox);
    walk.transformed ||= frame.transformed;
    walk.view = descend(walk.view, frame);
    walk.frameId = frame.frameId;
  }

  return walk;
}

let noArea: Rect = { left: 0, top: 0, width: 0, height: 0 };

// The part of the walked frame the page shows, in that frame's coordinates; no area when it is out of view.
export let localClip = (walk: Walk) =>
  walk.view.clip ? toLocal(walk.view.clip, walk.view) : noArea;

// Locates an element in its own frame, then confirms each ancestor shows its iframe at the chosen point; the result is in top-frame CSS px.
export async function locatePath(
  send: Send,
  ref: RefPath,
): Promise<PageLocateResult | Failure> {
  let path = parsePath(ref);

  if (!path.frames.length) {
    let located = await send(0, {
      op: "locate",
      ref: path.local,
      clip: null,
      scroll: true,
    });

    if (!located.ok) return located;

    let { candidates: _, ...rest } = located as LocateResult;
    return { ...rest, ref, sandboxed: false };
  }

  let revealed = await walkPath(send, path.frames, true);

  if (revealed.transformed)
    return {
      ok: false,
      error: `ref ${ref} is inside a CSS-transformed or zoomed iframe, which Accessibility lays out untransformed, so it cannot be matched`,
      code: "not_actionable",
    };

  let centered = await send(revealed.frameId, {
    op: "scrollIntoView",
    ref: path.local,
  });

  if (!centered.ok) return inFrame(centered, path);

  // Centering inside the frame may scroll its ancestors too, so the boxes are measured again.
  let walk = await walkPath(send, path.frames, false);

  if (
    walk.hops.some((hop, index) => hop.origin !== revealed.hops[index].origin)
  )
    return {
      ok: false,
      error: `a frame navigated while ref ${ref} was located; read_page again`,
      code: "stale_ref",
    };

  let located = await send(walk.frameId, {
    op: "locate",
    ref: path.local,
    clip: localClip(walk),
    scroll: false,
  });

  if (!located.ok) return inFrame(located, path);

  let child = located as LocateResult;
  let base = {
    ok: true as const,
    ref,
    rect: toTop(child.rect, walk.view),
    link: child.link,
    viewport: walk.viewport,
    sandboxed: walk.sandboxed,
  };

  if (!child.hitsTarget)
    return {
      ...base,
      point: toTop(child.point, walk.view),
      hitsTarget: false,
      covered: child.covered,
      hitDescription: child.hitDescription,
    };

  let points = child.candidates.map((point) => toTop(point, walk.view));
  let replies = await Promise.all(
    walk.hops.map((hop) =>
      send(hop.frameId, {
        op: "hitFrame",
        ref: hop.ref,
        points: points.map((point) => toLocal(point, hop.view)),
      }),
    ),
  );
  let failed = replies.find((reply) => !reply.ok);

  if (failed) return failed as Failure;

  let checks = replies as HitFrameResult[];
  let index = points.findIndex((_, at) =>
    checks.every((check) => check.hits[at]),
  );

  if (index >= 0)
    return {
      ...base,
      point: points[index],
      hitsTarget: true,
      covered: false,
      hitDescription: child.hitDescription,
    };

  let blocked = checks.findIndex((check) => !check.hits[0]);
  return {
    ...base,
    point: points[0],
    hitsTarget: false,
    covered: true,
    hitDescription: `iframe ${walk.hops[blocked].path} is covered there by ${checks[blocked].hitDescription}`,
  };
}

// Content errors name the frame's own ref, so say which frame they came from.
export function inFrame(failure: ContentResponse, path: Path): Failure {
  if (failure.ok)
    return { ok: false, error: "unexpected reply", code: "failed" };

  return {
    ...failure,
    error: path.frames.length
      ? `${failure.error} (in the frame of iframe ${path.frames.join(":")})`
      : failure.error,
  };
}

// The frame owning a path's element, without scrolling anything.
export async function owner(send: Send, ref: RefPath) {
  let path = parsePath(ref);

  if (!path.frames.length) return { path, frameId: 0 };

  return { path, frameId: (await walkPath(send, path.frames, false)).frameId };
}

// label names the frame in page text: its host, or srcdoc or about:blank.
export type Reached = {
  path: RefPath;
  frameId: number;
  view: FrameView;
  label: string;
  box: Rect | null;
};

type Node = Reached & { depth: number; children: Node[] };

let labelOf = (src: string) => (URL.canParse(src) && new URL(src).host) || src;

// Every frame a read fans out over, top first, then in document order: at most maxFrames below the top and maxFrameDepth deep, skipping unloaded and tiny frames.
export async function reachFrames(send: Send): Promise<Reached[] | Failure> {
  let top = await send(0, { op: "frames" });

  if (!top.ok) return top;

  let listed = top as FramesResult;

  let root: Node = {
    path: "",
    frameId: 0,
    view: topView(visibleArea(listed.viewport)),
    label: "",
    box: null,
    depth: 0,
    children: [],
  };
  let count = 0;
  let adopt = (node: Node, entries: FrameEntry[]) => {
    for (let entry of entries) {
      if (entry.frameId < 0 || count >= maxFrames) continue;

      if (entry.box.width < minFrameSize || entry.box.height < minFrameSize)
        continue;

      count++;
      node.children.push({
        path: node.path ? `${node.path}:${entry.ref}` : `${entry.ref}`,
        frameId: entry.frameId,
        view: descend(node.view, entry),
        label: labelOf(entry.src),
        box: entry.box,
        depth: node.depth + 1,
        children: [],
      });
    }

    return node.children.filter((child) => child.depth < maxFrameDepth);
  };
  let level = adopt(root, listed.frames);

  while (level.length) {
    let listings = await Promise.all(
      level.map((node) => timed(send, node.frameId, { op: "frames" })),
    );
    level = level.flatMap((node, index) => {
      let listing = listings[index];
      return listing.ok ? adopt(node, (listing as FramesResult).frames) : [];
    });
  }

  let flatten = ({ depth: _, children, ...node }: Node): Reached[] => [
    node,
    ...children.flatMap(flatten),
  ];
  return flatten(root);
}
