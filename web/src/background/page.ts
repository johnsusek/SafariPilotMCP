import { exactFirst, findLimit, onScreenFirst } from "../content/find";
import { clip } from "../content/pageText";
import { intersect } from "../content/geometry";
import type {
  CommandResponse,
  RefPath,
  PageConsoleResult,
  PageDiffResult,
  PageElement,
  PageEvent,
  PageRequest,
  PageTargetElement,
  PageTargetResult,
  PageWaitResult,
} from "../shared/commands";
import { toTop } from "../shared/frameGeometry";
import type {
  ClickResult,
  ConsoleResult,
  ContentResponse,
  DiffResult,
  DragResult,
  ElementInfo,
  EventsResult,
  Failure,
  FindResult,
  FocusResult,
  KeysResult,
  FrameBoxResult,
  InspectResult,
  PageTextResult,
  ReadPageResult,
  Rect,
  TargetResult,
  UploadResult,
  WaitForResult,
} from "../shared/protocol";
import {
  failureFrom,
  frameTimeoutMs,
  inFrame,
  localClip,
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
  withTimeout,
} from "./frames";

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
  return {
    ok: true as const,
    matches: onScreenFirst(matches).slice(0, findLimit),
  };
}

// Over the frames find reads, the only exact match wins, else the only match; anything else picks nothing, so the caller retries with a candidate's ref.
async function target(send: Send, request: PageRequest & { op: "target" }) {
  let answers = await fanOut(send, request);

  if (!Array.isArray(answers)) return answers;

  if (!answers[0].reply.ok) return answers[0].reply;

  let read = answers.filter(({ reply }) => reply.ok) as {
    frame: Reached;
    reply: TargetResult;
  }[];
  let matches: PageTargetElement[] = read.flatMap(({ frame, reply }) =>
    reply.matches.map((info) => ({
      ...element(info, frame),
      exact: info.exact,
    })),
  );
  let matched = read.reduce((sum, { reply }) => sum + reply.matched, 0);
  let exact = read.reduce((sum, { reply }) => sum + reply.exact, 0);
  let match: PageTargetElement | null = null;

  // Each frame lists its exact matches first, so the only one is never cut.
  if (exact === 1) match = matches.find((each) => each.exact)!;
  else if (matched === 1) match = matches[0];

  let candidates = match ? [] : exactFirst(matches).slice(0, findLimit);
  return {
    ok: true,
    match,
    matched,
    exact,
    candidates,
  } satisfies PageTargetResult;
}

// A page whose top frame has no content script yet or is mid-navigation is pending, not failed, so a wait polls on through a navigation; any other failure is the caller's.
let pending = (failure: Failure): PageWaitResult | Failure =>
  failure.code === "no_content_script" || failure.code === "timed_out"
    ? { ok: true, url: null, title: null, match: null, pending: failure.error }
    : failure;

// The top frame's match wins, then each reached frame's in document order; frames that do not answer are skipped, as find skips them.
async function waitFor(send: Send, request: PageRequest & { op: "waitFor" }) {
  let answers = await fanOut(send, request);

  if (!Array.isArray(answers)) return pending(answers);

  let top = answers[0].reply;

  if (!top.ok) return pending(top);

  let found = answers.find(
    ({ reply }) => reply.ok && (reply as WaitForResult).match,
  );
  let { url, title } = top as WaitForResult;
  let result: PageWaitResult = {
    ok: true,
    url,
    title,
    match: null,
    pending: null,
  };

  if (!found) return result;

  let match = (found.reply as WaitForResult).match!;
  return {
    ...result,
    match: { ...element(match, found.frame), text: match.text },
  };
}

// The top frame's text, then each big enough frame's in document order; with ref, the text of ref's element, then the frames inside it and the frames nested in those.
async function pageText(send: Send, request: PageRequest & { op: "pageText" }) {
  let { maxChars, format } = request;
  let target = request.ref === null ? null : await owner(send, request.ref);
  let own = {
    op: "pageText" as const,
    maxChars,
    format,
    ref: target?.path.local ?? null,
  };
  let [reply, reached] = await Promise.all([
    target && target.frameId !== 0
      ? timed(send, target.frameId, own)
      : send(0, own),
    target ? null : reachFrames(send),
  ]);

  if (!reply.ok) return target ? inFrame(reply, target.path) : reply;

  let { frames: inside, ...page } = reply as PageTextResult;
  let roots = inside.map((ref) => [...target!.path.frames, ref].join(":"));

  if (target && !roots.length) return page;

  reached ??= await reachFrames(send);

  if (!Array.isArray(reached)) return reached;

  let frames = reached
    .slice(1)
    .filter(
      (frame) =>
        !target ||
        roots.some(
          (root) => frame.path === root || frame.path.startsWith(`${root}:`),
        ),
    );
  let answers = await ask(send, frames, () => ({ ...own, ref: null }));
  // A frame asked for by its ref is read whatever its size.
  let sections = answers.flatMap(({ frame, reply }) => {
    let big =
      frame.path === request.ref ||
      (frame.box &&
        frame.box.width >= minTextFrame &&
        frame.box.height >= minTextFrame);
    let text = reply.ok ? (reply as PageTextResult).text : "";
    return big && text ? [`[frame ${frame.path} ${frame.label}]\n${text}`] : [];
  });
  let whole = clip(
    [page.text, ...sections].filter(Boolean).join("\n\n"),
    maxChars,
  );
  let truncated =
    whole.truncated ||
    page.truncated ||
    answers.some(
      ({ reply }) => reply.ok && (reply as PageTextResult).truncated,
    );
  return { ...page, text: whole.text, truncated };
}

// Merges every reached frame's newest matches by time and keeps the newest limit; the regular expression is checked here so a bad one fails once, not per frame.
async function consoleMessages(
  send: Send,
  request: PageRequest & { op: "console" },
) {
  if (request.pattern !== null) {
    try {
      new RegExp(request.pattern, "i");
    } catch (error) {
      return {
        ok: false as const,
        error: `pattern is not a valid regular expression: ${(error as Error).message}`,
        code: "invalid_argument" as const,
      };
    }
  }

  let answers = await fanOut(send, request);

  if (!Array.isArray(answers)) return answers;

  if (!answers[0].reply.ok) return answers[0].reply;

  let result: PageConsoleResult = {
    ok: true,
    entries: [],
    matched: 0,
    dropped: {},
    unread: [],
  };

  for (let { frame, reply } of answers) {
    let unread = (reason: string) =>
      result.unread.push({ path: frame.path, label: frame.label, reason });

    if (!reply.ok) {
      unread(reply.error);
      continue;
    }

    let taken = reply as ConsoleResult;

    if (!taken.capturing) {
      unread(
        "no console capture answered; the frame loaded before SafariPilot's extension (reload the page) or runs no scripts",
      );
      continue;
    }

    result.matched += taken.matched;

    if (taken.dropped) result.dropped[frame.path] = taken.dropped;

    result.entries.push(
      ...taken.entries.map((entry) => ({ ...entry, frame: frame.path })),
    );
  }

  result.entries.sort((first, second) => first.time - second.time);
  result.entries = result.entries.slice(-request.limit);
  return result;
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
    if (!reply.ok && reply.code === "timed_out") busy.push(frame.path);

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

// A diff reads only the top frame and the frame of the ref acted on, so ad frames neither add lines nor hold up the wait for quiet.
let actedFrames = (ref: RefPath | null) =>
  ref === null ? [] : parsePath(ref).frames;

let inActedFrame = (failure: Failure, frames: number[]): Failure => ({
  ...failure,
  error: `${failure.error} (in the frame of iframe ${frames.join(":")})`,
});

async function diffStart(
  send: Send,
  request: PageRequest & { op: "diffStart" },
) {
  let frames = actedFrames(request.ref);
  let top = await send(0, { op: "diffStart" });

  if (!top.ok || !frames.length) return top;

  let { frameId } = await walkPath(send, frames, false);
  let started = await timed(send, frameId, { op: "diffStart" });
  return started.ok ? top : inActedFrame(started, frames);
}

let noDiff: PageDiffResult = {
  ok: true,
  replaced: null,
  tooLarge: false,
  lines: [],
  added: 0,
  changed: 0,
  removed: 0,
  omitted: 0,
  untracked: [],
  pending: 0,
  settled: true,
};

let isChange = (line: string) => !line.startsWith("in ");

// Both frames wait for quiet at once; the acted frame's lines follow the top frame's within maxChars, and an iframe that is gone or has no frame took its document with it.
async function diff(send: Send, request: PageRequest & { op: "diff" }) {
  let { waitMs, maxChars } = request;
  let frames = actedFrames(request.ref);
  let path = frames.join(":");
  let topReply = send(0, { op: "diff", prefix: "", waitMs, maxChars });
  let frameReply = frames.length
    ? walkPath(send, frames, false).then(
        ({ frameId }) =>
          withTimeout(
            send(frameId, { op: "diff", prefix: `${path}:`, waitMs, maxChars }),
            waitMs + frameTimeoutMs,
            `no answer within ${waitMs + frameTimeoutMs} ms`,
          ),
        (error) => {
          let code = failureFrom(error)?.code;

          if (code === "stale_ref" || code === "not_actionable") return null;

          throw error;
        },
      )
    : undefined;
  let [top, frame] = await Promise.all([topReply, frameReply]);

  if (!top.ok) return top;

  if (frame && !frame.ok) return inActedFrame(frame, frames);

  let diffs = [top, frame].filter(Boolean) as DiffResult[];

  if (!diffs[0].started) return { ...noDiff, replaced: "" };

  if (frame === null || diffs[1]?.started === false)
    return { ...noDiff, replaced: path };

  if (diffs.some((result) => result.tooLarge))
    return { ...noDiff, tooLarge: true };

  let [first, second] = diffs;
  let lines = [...first.lines];
  let length = lines.join("\n").length;
  let omitted = first.omitted + (second?.omitted ?? 0);
  let cut = first.omitted > 0;

  for (let line of second?.lines ?? []) {
    let next = length + (lines.length ? 1 : 0) + line.length;
    cut ||= next > maxChars;

    if (cut) {
      if (isChange(line)) omitted++;

      continue;
    }

    lines.push(line);
    length = next;
  }

  if (lines.length && !isChange(lines.at(-1)!)) lines.pop();

  let sum = (key: "added" | "changed" | "removed" | "pending") =>
    diffs.reduce((total, result) => total + result[key], 0);
  return {
    ...noDiff,
    lines,
    added: sum("added"),
    changed: sum("changed"),
    removed: sum("removed"),
    omitted,
    untracked: diffs.flatMap((result, index) =>
      result.tracked ? [] : [index ? path : ""],
    ),
    pending: sum("pending"),
    settled: diffs.every((result) => result.settled),
  };
}

type ReadRequest = PageRequest & { op: "readPage" };

// What a viewport read left out of a frame, for its iframe line; nothing when none was.
let leftOut = (read: ReadPageResult) =>
  read.above || read.below
    ? ` (viewport only; ${read.above} px above and ${read.below} px below left out)`
    : "";

// Reads one frame's tree, then each frame under its iframe lines with what is left of maxChars at that line, indented one level below it.
// A viewport read reads only the frames in view, each within the part of it shown.
async function readFrame(
  send: Send,
  frameId: number,
  prefix: string,
  request: Omit<ReadRequest, "op" | "ref"> & {
    ref: number | null;
    clip: Rect | null;
  },
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

    if (request.viewport && !placeholder.clip) return { placeholder, note: "" };

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
      { ...request, maxChars: room, ref: null, depth, clip: placeholder.clip },
      frameDepth + 1,
      budget,
    );
    return {
      placeholder,
      note: child.ok ? leftOut(child) : " (frame did not answer)",
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

// A ref inside a frame is read within the part of its frame the page shows, which is nowhere when the frame is out of view.
async function readPage(send: Send, request: ReadRequest) {
  let path = request.ref === null ? null : parsePath(request.ref);
  let frames = path?.frames ?? [];
  let walk = frames.length ? await walkPath(send, frames, false) : null;
  let clip = walk && request.viewport ? localClip(walk) : null;
  let read = await readFrame(
    send,
    walk?.frameId ?? 0,
    frames.map((ref) => `${ref}:`).join(""),
    { ...request, ref: path?.local ?? null, clip },
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

  if (request.op === "console") return await consoleMessages(send, request);

  if (request.op === "readPage") return await readPage(send, request);

  if (request.op === "find") return await find(send, request);

  if (request.op === "target") return await target(send, request);

  if (request.op === "waitFor") return await waitFor(send, request);

  if (request.op === "pageText") return await pageText(send, request);

  if (request.op === "diffStart") return await diffStart(send, request);

  if (request.op === "diff") return await diff(send, request);

  if (request.op === "scroll" && request.ref === null)
    return await send(0, { ...request, ref: null });

  if (request.op === "keys" && request.ref === null)
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

  if (request.op === "drag") {
    let to = parsePath(request.to);

    if (to.frames.join(":") !== path.frames.join(":"))
      return {
        ok: false,
        error: `refs ${request.ref} and ${request.to} are in different frames; a drag runs inside one frame`,
        code: "invalid_argument",
      };

    let dragged = await send(frameId, {
      op: "drag",
      ref: path.local,
      to: to.local,
    });
    return dragged.ok
      ? { ...(dragged as DragResult), ref: request.ref, to: request.to }
      : inFrame(dragged, path);
  }

  if (request.op === "scroll") {
    let scrolled = await send(frameId, { ...request, ref: path.local });
    return scrolled.ok ? scrolled : inFrame(scrolled, path);
  }

  if (
    request.op === "syntheticClick" ||
    request.op === "upload" ||
    request.op === "focus" ||
    request.op === "keys"
  ) {
    let acted = await send(frameId, { ...request, ref: path.local });
    return acted.ok
      ? {
          ...(acted as ClickResult | UploadResult | FocusResult | KeysResult),
          ref: request.ref!,
        }
      : inFrame(acted, path);
  }

  let inspected = await send(
    frameId,
    request.op === "setValue" || request.op === "selectOption"
      ? { ...request, ref: path.local }
      : { op: "inspect", ref: path.local },
  );
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
    return (
      failureFrom(error) ?? {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: "failed",
      }
    );
  }
}
