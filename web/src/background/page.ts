import { clip } from "../content/pageText";
import { intersect } from "../content/geometry";
import type {
  CommandResponse,
  PageElement,
  PageEvent,
  PageRequest,
} from "../shared/commands";
import { toTop } from "../shared/frameGeometry";
import type {
  ContentResponse,
  ElementInfo,
  EventsResult,
  Failure,
  FindResult,
  FrameBoxResult,
  InspectResult,
  PageTextResult,
  ReadPageResult,
} from "../shared/protocol";
import {
  inFrame,
  locatePath,
  maxFrameDepth,
  maxFrames,
  minFrameSize,
  owner,
  parsePath,
  type Reached,
  reachFrames,
  type Send,
  timed,
  walkPath,
} from "./frames";

let findLimit = 20;
// Frames smaller than this hold widgets, not text worth reading.
let minTextFrame = 50;

let prefixed = (path: string, ref: number) =>
  path ? `${path}:${ref}` : `${ref}`;

// Asks each frame at once; the top frame gets no timeout, since it answers for the page.
async function ask(
  send: Send,
  frames: Reached[],
  request: (frame: Reached) => Parameters<Send>[1],
) {
  let replies = await Promise.all(
    frames.map((frame) =>
      frame.frameId === 0
        ? send(0, request(frame))
        : timed(send, frame.frameId, request(frame)),
    ),
  );
  return frames.map((frame, index) => ({ frame, reply: replies[index] }));
}

async function fanOut(send: Send, request: Parameters<Send>[1]) {
  let frames = await reachFrames(send);

  if (!Array.isArray(frames)) return frames;

  return await ask(send, frames, () => request);
}

let element = (info: ElementInfo, frame: Reached): PageElement => {
  let rect = toTop(info.rect, frame.view);
  let shown =
    frame.view.clip !== null && intersect(rect, frame.view.clip) !== null;
  return {
    ...info,
    ref: prefixed(frame.path, info.ref),
    rect,
    inViewport: info.inViewport && shown,
  };
};

async function find(send: Send, request: PageRequest & { op: "find" }) {
  let answers = await fanOut(send, request);

  if (!Array.isArray(answers)) return answers;

  if (!answers[0].reply.ok) return answers[0].reply;

  let matches = answers.flatMap(({ frame, reply }) =>
    reply.ok
      ? (reply as FindResult).matches.map((info) => element(info, frame))
      : [],
  );
  // As in each frame, on-screen matches come before offscreen ones in the cap.
  let ordered = [
    ...matches.filter((match) => match.inViewport),
    ...matches.filter((match) => !match.inViewport),
  ];
  return { ok: true as const, matches: ordered.slice(0, findLimit) };
}

async function pageText(send: Send, maxChars: number) {
  let answers = await fanOut(send, { op: "pageText", maxChars });

  if (!Array.isArray(answers)) return answers;

  let top = answers[0].reply;

  if (!top.ok) return top;

  let sections = answers.slice(1).flatMap(({ frame, reply }) => {
    let big =
      frame.box &&
      frame.box.width >= minTextFrame &&
      frame.box.height >= minTextFrame;
    let text = reply.ok ? (reply as PageTextResult).text : "";
    return big && text ? [`[frame ${frame.path} ${frame.label}]\n${text}`] : [];
  });
  let page = top as PageTextResult;
  let whole = clip(
    [page.text, ...sections].filter(Boolean).join("\n\n"),
    maxChars,
  );
  let truncated =
    whole.truncated ||
    answers.some(
      ({ reply }) => reply.ok && (reply as PageTextResult).truncated,
    );
  return { ...page, text: whole.text, truncated };
}

// The watched ref's frame is read even when the fan-out's caps leave it out, since an action there is verified by its events; a frame that is gone is left out.
async function events(send: Send, request: PageRequest & { op: "events" }) {
  let frames = await reachFrames(send);

  if (!Array.isArray(frames)) return frames;

  let watch = request.watch === null ? null : parsePath(request.watch);
  let watchFrame = watch?.frames.join(":") ?? null;

  if (watch && !frames.some((frame) => frame.path === watchFrame)) {
    let walk = await walkPath(send, watch.frames, false).catch(() => null);

    if (walk)
      frames.push({
        path: watchFrame!,
        frameId: walk.frameId,
        view: walk.view,
        label: "",
        box: null,
      });
  }

  let answers = await ask(send, frames, (frame) => ({
    op: "events",
    clear: request.clear,
    arm: request.arm,
    watch: frame.path === watchFrame ? watch!.local : null,
  }));

  if (!answers[0].reply.ok) return answers[0].reply;

  let origins: Record<string, number> = {};
  let busy: string[] = [];
  let logged: PageEvent[] = [];

  for (let { frame, reply } of answers) {
    if (!reply.ok && reply.timeout) busy.push(frame.path);

    if (!reply.ok) continue;

    let result = reply as EventsResult;
    origins[frame.path] = result.origin;
    logged.push(
      ...result.events.map((event) => ({
        ...event,
        ref: event.ref === null ? null : prefixed(frame.path, event.ref),
        frame: frame.path,
      })),
    );
  }

  logged.sort((first, second) => first.time - second.time);
  return {
    ok: true as const,
    events: logged,
    origin: origins[""],
    origins,
    busy,
  };
}

type ReadRequest = PageRequest & { op: "readPage" };

// Reads one frame's tree, then each frame under its iframe lines with what is left of maxChars at that line, indented one level below it.
async function readFrame(
  send: Send,
  frameId: number,
  prefix: string,
  request: Omit<ReadRequest, "op" | "ref"> & { ref: number | null },
  frameDepth: number,
  budget: { frames: number },
): Promise<ReadPageResult | Failure> {
  let readRequest = { op: "readPage" as const, ...request, prefix };
  let reply: ContentResponse =
    frameId === 0
      ? await send(0, readRequest)
      : await timed(send, frameId, readRequest);

  if (!reply.ok) return reply;

  let read = reply as ReadPageResult;
  let lines = read.text ? read.text.split("\n") : [];
  let truncated = read.truncated;
  let children = read.frames.map(async (placeholder) => {
    let depth =
      request.depth === null ? null : request.depth - placeholder.depth - 1;

    if (depth !== null && depth < 1) return { placeholder, note: "" };

    if (placeholder.width < minFrameSize || placeholder.height < minFrameSize)
      return { placeholder, note: "" };

    if (frameDepth >= maxFrameDepth)
      return {
        placeholder,
        note: ` (not read: frames nest ${maxFrameDepth} deep at most)`,
      };

    if (budget.frames <= 0)
      return { placeholder, note: ` (not read: ${maxFrames} frames per call)` };

    let room =
      request.maxChars -
      lines.slice(0, placeholder.line + 1).join("\n").length -
      1;

    if (room <= 0) return { placeholder, note: "" };

    budget.frames--;
    let child = await readFrame(
      send,
      placeholder.frameId,
      `${prefix}${placeholder.ref}:`,
      { ...request, maxChars: room, ref: null, depth },
      frameDepth + 1,
      budget,
    );
    return {
      placeholder,
      note: child.ok ? "" : " (frame did not answer)",
      child,
    };
  });

  for (let { placeholder, note, child } of (
    await Promise.all(children)
  ).reverse()) {
    lines[placeholder.line] += note;

    if (!child?.ok || !child.text) continue;

    let indent = "  ".repeat(placeholder.depth + 1);
    truncated ||= child.truncated;
    lines.splice(
      placeholder.line + 1,
      0,
      ...child.text.split("\n").map((line) => indent + line),
    );
  }

  let whole = clip(lines.join("\n"), request.maxChars);
  return {
    ...read,
    text: whole.text,
    truncated: truncated || whole.truncated,
    frames: [],
  };
}

async function readPage(send: Send, request: ReadRequest) {
  let path = request.ref === null ? null : parsePath(request.ref);
  let frames = path?.frames ?? [];
  let frameId = frames.length
    ? (await walkPath(send, frames, false)).frameId
    : 0;
  let read = await readFrame(
    send,
    frameId,
    frames.map((ref) => `${ref}:`).join(""),
    { ...request, ref: path?.local ?? null },
    frames.length,
    { frames: maxFrames },
  );

  if (!read.ok) return path ? inFrame(read, path) : read;

  let { frames: _, ...rest } = read;
  return rest;
}

async function dispatch(
  send: Send,
  request: PageRequest,
): Promise<CommandResponse> {
  if (request.op === "ping") return await send(0, request);

  if (request.op === "snapshot") {
    let snapshot = await send(0, request);

    if (!snapshot.ok || !("elements" in snapshot)) return snapshot;

    return {
      ...snapshot,
      elements: snapshot.elements.map((info) => ({
        ...info,
        ref: `${info.ref}`,
      })),
    };
  }

  if (request.op === "locate") return await locatePath(send, request.ref);

  if (request.op === "events") return await events(send, request);

  if (request.op === "readPage") return await readPage(send, request);

  if (request.op === "find") return await find(send, request);

  if (request.op === "pageText") return await pageText(send, request.maxChars);

  if (request.op === "scroll" && request.ref === null)
    return await send(0, { ...request, ref: null });

  if (request.op === "scrollIntoView") {
    let path = parsePath(request.ref);
    let walk = path.frames.length
      ? await walkPath(send, path.frames, true)
      : null;
    let scrolled = await send(walk?.frameId ?? 0, {
      op: "scrollIntoView",
      ref: path.local,
    });

    if (!scrolled.ok || !("moved" in scrolled)) return inFrame(scrolled, path);

    if (!walk) return scrolled;

    // Report the page's scroll position, not the frame's; centering inside the frame may have scrolled the page too.
    let top = await send(0, {
      op: "frameBox",
      ref: path.frames[0],
      reveal: false,
    });

    if (!top.ok) return inFrame(top, path);

    let { viewport } = top as FrameBoxResult;
    let pageMoved =
      viewport.scrollX !== walk.viewport.scrollX ||
      viewport.scrollY !== walk.viewport.scrollY;
    return {
      ok: true,
      moved: scrolled.moved || walk.moved || pageMoved,
      viewport,
    };
  }

  let { path, frameId } = await owner(send, request.ref!);

  if (request.op === "scroll") {
    let scrolled = await send(frameId, { ...request, ref: path.local });
    return scrolled.ok ? scrolled : inFrame(scrolled, path);
  }

  let inspected = await send(frameId, { op: "inspect", ref: path.local });
  return inspected.ok
    ? { ...(inspected as InspectResult), ref: request.ref }
    : inFrame(inspected, path);
}

// Runs a page request against the tab's frames; refs name their frame, so the non-persistent background keeps no map between calls.
export async function runPage(
  send: Send,
  request: PageRequest,
): Promise<CommandResponse> {
  try {
    return await dispatch(send, request);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
