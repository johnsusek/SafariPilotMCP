import { beforeEach, describe, expect, test } from "vitest";
import type {
  ContentRequest,
  ContentResponse,
  FrameEntry,
  Rect,
  Viewport,
} from "../shared/protocol";
import {
  locatePath,
  parsePath,
  reachFrames,
  type Send,
  walkPath,
} from "./frames";
import { runPage } from "./page";

let viewport = (width = 1000, height = 800): Viewport => ({
  innerWidth: width,
  innerHeight: height,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 2,
  visualScale: 1,
  visualOffsetLeft: 0,
  visualOffsetTop: 0,
  visualWidth: width,
  visualHeight: height,
  clientWidth: width,
  clientHeight: height,
});

let rect = (
  left: number,
  top: number,
  width: number,
  height: number,
): Rect => ({
  left,
  top,
  width,
  height,
});

let entry = (
  ref: number,
  frameId: number,
  box: Rect,
  extra: Partial<FrameEntry> = {},
): FrameEntry => ({
  ref,
  frameId,
  src: `https://f${frameId}.test/page`,
  sandbox: null,
  box,
  clip: box,
  transformed: false,
  ...extra,
});

type Document = {
  frames: FrameEntry[];
  viewport: Viewport;
  origin: number;
  // Which points (by index) land on each iframe ref; all of them when absent.
  hits?: Record<number, boolean[]>;
  answer?: (request: ContentRequest) => ContentResponse | undefined;
};

let documents: Record<number, Document>;
let calls: [number, ContentRequest][];

let send: Send = async (frameId, request) => {
  calls.push([frameId, request]);
  let page = documents[frameId];

  if (!page)
    return {
      ok: false,
      error: `no content script answered in frame ${frameId}`,
    };

  let custom = page.answer?.(request);

  if (custom) return custom;

  if (request.op === "frames")
    return {
      ok: true,
      url: "u",
      title: "t",
      viewport: page.viewport,
      frames: page.frames,
    };

  if (request.op === "frameBox") {
    let frame = page.frames.find((each) => each.ref === request.ref);

    if (!frame) return { ok: false, error: `ref ${request.ref} is unknown` };

    return {
      ok: true,
      frame,
      moved: request.reveal,
      viewport: page.viewport,
      origin: page.origin,
    };
  }

  if (request.op === "hitFrame")
    return {
      ok: true,
      hits: page.hits?.[request.ref] ?? request.points.map(() => true),
      hitDescription: "div#overlay",
    };

  if (request.op === "scrollIntoView")
    return { ok: true, moved: true, viewport: page.viewport };

  return { ok: false, error: `unhandled ${request.op}` };
};

let located = (candidates: { left: number; top: number }[]) => ({
  ok: true as const,
  ref: 12,
  rect: rect(0, 0, 100, 20),
  point: candidates[0],
  hitsTarget: true,
  covered: false,
  hitDescription: "button",
  viewport: viewport(200, 100),
  candidates,
});

// Top frame 0 holds iframe 5 (frame 100) at (10, 100); frame 100 holds iframe 3 (frame 200) at (20, 30).
beforeEach(() => {
  calls = [];
  documents = {
    0: {
      frames: [entry(5, 100, rect(10, 100, 400, 300))],
      viewport: viewport(),
      origin: 1,
    },
    100: {
      frames: [entry(3, 200, rect(20, 30, 200, 100))],
      viewport: viewport(400, 300),
      origin: 2,
    },
    200: { frames: [], viewport: viewport(200, 100), origin: 3 },
  };
});

describe("parsePath", () => {
  test("splits frames from the local ref", () => {
    expect(parsePath("12")).toEqual({ frames: [], local: 12 });
    expect(parsePath("5:3:12")).toEqual({ frames: [5, 3], local: 12 });
  });

  test("refuses dots, blanks and more than 3 frames", () => {
    for (let bad of ["5.12", "", "5:", "1:2:3:4:5", "-1"])
      expect(() => parsePath(bad)).toThrow(/must look like 12, or 5:12/);
  });
});

describe("walkPath", () => {
  test("composes iframe offsets and clips into the top frame", async () => {
    documents[0].frames[0] = entry(5, 100, rect(10, 700, 400, 300), {
      clip: rect(10, 700, 400, 100),
    });
    let walk = await walkPath(send, [5, 3], false);
    expect(walk.frameId).toBe(200);
    expect(walk.view.offset).toEqual({ left: 30, top: 730 });
    expect(walk.view.clip).toEqual(rect(30, 730, 200, 70));
    expect(
      walk.hops.map((hop) => [hop.path, hop.frameId, hop.view.offset]),
    ).toEqual([
      ["5", 0, { left: 0, top: 0 }],
      ["5:3", 100, { left: 10, top: 700 }],
    ]);
  });

  test("names the hop that fails", async () => {
    documents[100].frames = [];
    await expect(walkPath(send, [5, 3], false)).rejects.toThrow(
      "in the frame of iframe 5: ref 3 is unknown",
    );
    documents[0].frames[0].frameId = -1;
    await expect(walkPath(send, [5, 3], false)).rejects.toThrow(
      "iframe 5 has no frame yet; scroll_to 5",
    );
    delete documents[0];
    await expect(walkPath(send, [5], false)).rejects.toThrow(
      "no content script answered in frame 0",
    );
  });

  test("a sandbox without allow-scripts anywhere on the path marks it", async () => {
    documents[0].frames[0].sandbox = "allow-same-origin";
    expect((await walkPath(send, [5, 3], false)).sandboxed).toBe(true);
    documents[0].frames[0].sandbox = "allow-scripts allow-same-origin";
    expect((await walkPath(send, [5, 3], false)).sandboxed).toBe(false);
  });
});

describe("locatePath", () => {
  test("a top-frame ref is located in frame 0 as before", async () => {
    documents[0].answer = (request) =>
      request.op === "locate" ? { ...located([]), ref: 7 } : undefined;
    let result = await locatePath(send, "7");
    expect(calls[0]).toEqual([
      0,
      { op: "locate", ref: 7, clip: null, scroll: true },
    ]);
    expect(result).toMatchObject({ ok: true, ref: "7", sandboxed: false });
    expect(result).not.toHaveProperty("candidates");
  });

  test("maps the first point every ancestor shows to the top frame", async () => {
    let candidates = [
      { left: 5, top: 5 },
      { left: 50, top: 50 },
    ];
    documents[200].answer = (request) =>
      request.op === "locate" ? located(candidates) : undefined;
    documents[0].hits = { 5: [false, true] };
    let result = await locatePath(send, "5:3:12");
    expect(result).toMatchObject({
      ok: true,
      ref: "5:3:12",
      rect: rect(30, 130, 100, 20),
      point: { left: 80, top: 180 },
      hitsTarget: true,
      viewport: viewport(),
    });
    let locate = calls.find(([, request]) => request.op === "locate");
    expect(locate).toEqual([
      200,
      { op: "locate", ref: 12, clip: rect(0, 0, 200, 100), scroll: false },
    ]);
    let hitFrames = calls.filter(([, request]) => request.op === "hitFrame");
    expect(hitFrames).toContainEqual([
      0,
      {
        op: "hitFrame",
        ref: 5,
        points: [
          { left: 35, top: 135 },
          { left: 80, top: 180 },
        ],
      },
    ]);
    expect(hitFrames).toContainEqual([
      100,
      {
        op: "hitFrame",
        ref: 3,
        points: [
          { left: 25, top: 35 },
          { left: 70, top: 80 },
        ],
      },
    ]);
  });

  test("reports the covering element when no point gets through", async () => {
    documents[200].answer = (request) =>
      request.op === "locate" ? located([{ left: 5, top: 5 }]) : undefined;
    documents[100].hits = { 3: [false] };
    expect(await locatePath(send, "5:3:12")).toMatchObject({
      hitsTarget: false,
      covered: true,
      hitDescription: "iframe 5:3 is covered there by div#overlay",
    });
  });

  test("refuses a transformed frame and a frame that navigated", async () => {
    documents[100].frames[0].transformed = true;
    expect(await locatePath(send, "5:3:12")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/CSS-transformed/),
    });
    documents[100].frames[0].transformed = false;
    documents[200].answer = (request) =>
      request.op === "scrollIntoView"
        ? ((documents[100].origin = 9), undefined)
        : undefined;
    expect(await locatePath(send, "5:3:12")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/navigated/),
    });
  });

  test("a child error names its frame", async () => {
    documents[200].answer = (request) =>
      request.op === "scrollIntoView"
        ? { ok: false, error: "ref 12 is unknown" }
        : undefined;
    expect(await locatePath(send, "5:3:12")).toEqual({
      ok: false,
      error: "ref 12 is unknown (in the frame of iframe 5:3)",
    });
  });
});

describe("reachFrames", () => {
  test("lists frames in document order within the caps", async () => {
    documents[0].frames.push(
      entry(6, -1, rect(0, 0, 100, 100)),
      entry(7, 300, rect(0, 0, 10, 10)),
      entry(8, 400, rect(0, 500, 100, 100)),
    );
    documents[400] = { frames: [], viewport: viewport(100, 100), origin: 4 };
    let reached = await reachFrames(send);
    expect(
      Array.isArray(reached) &&
        reached.map((frame) => [frame.path, frame.frameId]),
    ).toEqual([
      ["", 0],
      ["5", 100],
      ["5:3", 200],
      ["8", 400],
    ]);
  });

  test("stops at 20 frames and 3 levels", async () => {
    documents[0].frames = Array.from({ length: 25 }, (_, index) =>
      entry(index + 1, 1000 + index, rect(0, 0, 50, 50)),
    );
    expect(((await reachFrames(send)) as unknown[]).length).toBe(21);
    documents[0].frames = [entry(1, 1, rect(0, 0, 50, 50))];

    for (let level = 1; level <= 5; level++)
      documents[level] = {
        frames: [entry(1, level + 1, rect(0, 0, 50, 50))],
        viewport: viewport(50, 50),
        origin: level,
      };

    let paths = ((await reachFrames(send)) as { path: string }[]).map(
      (frame) => frame.path,
    );
    expect(paths).toEqual(["", "1", "1:1", "1:1:1"]);
  });
});

describe("runPage reads", () => {
  test("read_page splices each frame under its iframe line, indented and prefixed", async () => {
    documents[0].answer = (request) =>
      request.op === "readPage"
        ? {
            ok: true,
            url: "u",
            title: "t",
            viewport: viewport(),
            text: 'main\n  iframe "A" [ref=5]\nfooter',
            truncated: false,
            frames: [
              {
                ref: 5,
                frameId: 100,
                line: 1,
                depth: 1,
                width: 400,
                height: 300,
              },
            ],
          }
        : undefined;
    documents[100].answer = (request) =>
      request.op === "readPage"
        ? {
            ok: true,
            url: "u",
            title: "t",
            viewport: viewport(),
            text: `button "Go" [ref=${request.prefix}2]\niframe [ref=${request.prefix}3]`,
            truncated: false,
            frames: [
              {
                ref: 3,
                frameId: 200,
                line: 1,
                depth: 0,
                width: 200,
                height: 100,
              },
            ],
          }
        : undefined;
    documents[200].answer = (request) =>
      request.op === "readPage"
        ? {
            ok: true,
            url: "u",
            title: "t",
            viewport: viewport(),
            text: `link [ref=${request.prefix}9]`,
            truncated: false,
            frames: [],
          }
        : undefined;
    let result = await runPage(send, {
      op: "readPage",
      filter: "all",
      maxChars: 1000,
      ref: null,
      depth: null,
    });
    expect(result).toMatchObject({
      ok: true,
      truncated: false,
      text: [
        "main",
        '  iframe "A" [ref=5]',
        '    button "Go" [ref=5:2]',
        "    iframe [ref=5:3]",
        "      link [ref=5:3:9]",
        "footer",
      ].join("\n"),
    });
    expect(result).not.toHaveProperty("frames");

    let cut = await runPage(send, {
      op: "readPage",
      filter: "all",
      maxChars: 60,
      ref: null,
      depth: null,
    });
    expect(cut).toMatchObject({
      truncated: true,
      text: 'main\n  iframe "A" [ref=5]\n    button "Go" [ref=5:2]\nfooter',
    });
    let child = calls
      .filter(
        ([frameId, request]) => frameId === 100 && request.op === "readPage",
      )
      .at(-1);
    expect(child?.[1]).toMatchObject({
      maxChars: 60 - 'main\n  iframe "A" [ref=5]'.length - 1,
      prefix: "5:",
    });

    let shallow = await runPage(send, {
      op: "readPage",
      filter: "all",
      maxChars: 1000,
      ref: null,
      depth: 2,
    });
    expect(shallow).toMatchObject({
      text: 'main\n  iframe "A" [ref=5]\nfooter',
    });
  });

  test("read_page from a ref inside a frame starts there", async () => {
    documents[100].answer = (request) =>
      request.op === "readPage"
        ? {
            ok: true,
            url: "u",
            title: "t",
            viewport: viewport(),
            text: `button [ref=${request.prefix}${request.ref}]`,
            truncated: false,
            frames: [],
          }
        : undefined;
    expect(
      await runPage(send, {
        op: "readPage",
        filter: "all",
        maxChars: 1000,
        ref: "5:2",
        depth: null,
      }),
    ).toMatchObject({ text: "button [ref=5:2]" });
  });

  test("find merges frames on-screen first, prefixes refs and maps rects to the top frame", async () => {
    let match = (ref: number, top: number) => ({
      ref,
      tag: "a",
      role: "link",
      name: "x",
      rect: rect(0, top, 10, 10),
      inViewport: true,
    });
    documents[0].answer = (request) =>
      request.op === "find"
        ? {
            ok: true,
            matches: Array.from({ length: 15 }, (_, index) =>
              match(index + 1, 0),
            ),
          }
        : undefined;
    documents[100].answer = (request) =>
      request.op === "find"
        ? { ok: true, matches: [match(2, 0), match(4, 250)] }
        : undefined;
    documents[200].answer = (request) =>
      request.op === "find"
        ? {
            ok: true,
            matches: Array.from({ length: 10 }, (_, index) =>
              match(index + 1, 0),
            ),
          }
        : undefined;
    documents[0].frames[0] = entry(5, 100, rect(10, 600, 400, 300), {
      clip: rect(10, 600, 400, 200),
    });
    let result = await runPage(send, { op: "find", name: "x", role: "" });
    let matches = (
      result as { matches: { ref: string; rect: Rect; inViewport: boolean }[] }
    ).matches;
    expect(matches.length).toBe(20);
    expect(
      matches
        .slice(14, 18)
        .map((each) => [each.ref, each.rect.top, each.inViewport]),
    ).toEqual([
      ["15", 0, true],
      ["5:2", 600, true],
      ["5:3:1", 630, true],
      ["5:3:2", 630, true],
    ]);
    // 5:4 is below the frame's clip, so the 26 on-screen matches leave it out.
    expect(matches.map((each) => each.ref)).not.toContain("5:4");
  });

  test("events carry the frame they came from and every frame's origin", async () => {
    let event = (ref: number | null, time: number) => ({
      type: "keydown",
      isTrusted: true,
      ref,
      target: "input",
      time,
      detail: "",
      count: 1,
    });
    documents[0].answer = (request) =>
      request.op === "events"
        ? { ok: true, events: [event(1, 5)], origin: 1 }
        : undefined;
    documents[100].answer = (request) =>
      request.op === "events"
        ? { ok: true, events: [event(null, 2)], origin: 2 }
        : undefined;
    documents[200].answer = (request) =>
      request.op === "events"
        ? { ok: true, events: [event(7, 9)], origin: 3 }
        : undefined;
    expect(
      await runPage(send, {
        op: "events",
        clear: true,
        arm: false,
        watch: null,
      }),
    ).toEqual({
      ok: true,
      origin: 1,
      origins: { "": 1, "5": 2, "5:3": 3 },
      busy: [],
      events: [
        { ...event(null, 2), frame: "5" },
        { ...event(null, 5), ref: "1", frame: "" },
        { ...event(null, 9), ref: "5:3:7", frame: "5:3" },
      ],
    });
  });

  test("events always read the watched frame, mark it, and list frames that timed out as busy", async () => {
    // Iframe 3 is too small for the fan-out, so only the watch reaches frame 200.
    documents[100].frames = [entry(3, 200, rect(20, 30, 10, 10))];
    documents[0].answer = (request) =>
      request.op === "events" ? { ok: true, events: [], origin: 1 } : undefined;
    documents[100].answer = (request) =>
      request.op === "events"
        ? { ok: false, error: "no answer within 2000 ms", timeout: true }
        : undefined;
    documents[200].answer = (request) =>
      request.op === "events" ? { ok: true, events: [], origin: 3 } : undefined;
    expect(
      await runPage(send, {
        op: "events",
        clear: true,
        arm: false,
        watch: "5:3:7",
      }),
    ).toMatchObject({ origins: { "": 1, "5:3": 3 }, busy: ["5"] });
    let watched = calls.filter(([, request]) => request.op === "events");
    expect(watched).toContainEqual([
      200,
      { op: "events", clear: true, arm: false, watch: 7 },
    ]);
    expect(watched).toContainEqual([
      0,
      { op: "events", clear: true, arm: false, watch: null },
    ]);
  });

  test("console merges frames by time, keeps the newest limit and names unread frames", async () => {
    let message = (text: string, time: number) => ({
      level: "log" as const,
      text,
      time,
      url: "u",
      source: null,
    });
    let request = {
      op: "console" as const,
      onlyErrors: false,
      pattern: "a",
      limit: 2,
      clear: true,
    };
    documents[0].answer = (asked) =>
      asked.op === "console"
        ? {
            ok: true,
            capturing: true,
            entries: [message("top a", 5), message("top b", 9)],
            matched: 4,
            dropped: 3,
          }
        : undefined;
    documents[100].answer = (asked) =>
      asked.op === "console"
        ? {
            ok: true,
            capturing: true,
            entries: [message("frame", 7)],
            matched: 1,
            dropped: 0,
          }
        : undefined;
    documents[200].answer = (asked) =>
      asked.op === "console"
        ? {
            ok: true,
            capturing: false,
            entries: [],
            matched: 0,
            dropped: 0,
          }
        : undefined;
    expect(await runPage(send, request)).toEqual({
      ok: true,
      entries: [
        { ...message("frame", 7), frame: "5" },
        { ...message("top b", 9), frame: "" },
      ],
      matched: 5,
      dropped: { "": 3 },
      unread: [
        {
          path: "5:3",
          label: "f200.test",
          reason: expect.stringMatching(/^no console capture/),
        },
      ],
    });
    expect(calls).toContainEqual([100, request]);
    calls = [];
    expect(
      await runPage(send, { ...request, pattern: "(unclosed" }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /^pattern is not a valid regular expression/,
      ),
    });
    expect(calls).toEqual([]);
  });

  test("read_page skips frames smaller than tracking-pixel size without spending the frame budget", async () => {
    documents[0].answer = (request) =>
      request.op === "readPage"
        ? {
            ok: true,
            url: "u",
            title: "t",
            viewport: viewport(),
            text: 'iframe [ref=4]\niframe "A" [ref=5]',
            truncated: false,
            frames: [
              { ref: 4, frameId: 100, line: 0, depth: 0, width: 1, height: 1 },
              {
                ref: 5,
                frameId: 200,
                line: 1,
                depth: 0,
                width: 400,
                height: 300,
              },
            ],
          }
        : undefined;
    documents[200].answer = (request) =>
      request.op === "readPage"
        ? {
            ok: true,
            url: "u",
            title: "t",
            viewport: viewport(),
            text: `link [ref=${request.prefix}9]`,
            truncated: false,
            frames: [],
          }
        : undefined;
    expect(
      await runPage(send, {
        op: "readPage",
        filter: "all",
        maxChars: 1000,
        ref: null,
        depth: null,
      }),
    ).toMatchObject({
      text: 'iframe [ref=4]\niframe "A" [ref=5]\n  link [ref=5:9]',
    });
    expect(
      calls.some(
        ([frameId, request]) => frameId === 100 && request.op === "readPage",
      ),
    ).toBe(false);
  });

  test("page text appends a labeled section per sizable frame", async () => {
    documents[0].answer = (request) =>
      request.op === "pageText"
        ? { ok: true, url: "u", title: "t", text: "Top text", truncated: false }
        : undefined;
    documents[100].answer = (request) =>
      request.op === "pageText"
        ? {
            ok: true,
            url: "u",
            title: "t",
            text: "Frame text",
            truncated: false,
          }
        : undefined;
    documents[200].answer = (request) =>
      request.op === "pageText"
        ? { ok: true, url: "u", title: "t", text: "", truncated: false }
        : undefined;
    expect(
      await runPage(send, { op: "pageText", maxChars: 1000 }),
    ).toMatchObject({
      url: "u",
      text: "Top text\n\n[frame 5 f100.test]\nFrame text",
      truncated: false,
    });
  });

  test("inspect, setColor, scroll, syntheticClick and upload route to the owning frame", async () => {
    documents[200].answer = (request) =>
      request.op === "inspect" || request.op === "setColor"
        ? {
            ok: true,
            ref: request.ref,
            hover: false,
            value: "v",
            secure: false,
            kind: "text",
            checked: null,
            selectedIndex: null,
            options: null,
          }
        : request.op === "scroll"
          ? { ok: true, moved: true, viewport: viewport() }
          : undefined;
    expect(await runPage(send, { op: "inspect", ref: "5:3:4" })).toMatchObject({
      ok: true,
      ref: "5:3:4",
      value: "v",
    });
    expect(
      await runPage(send, { op: "setColor", ref: "5:3:4", value: "#00ff00" }),
    ).toMatchObject({ ok: true, ref: "5:3:4" });
    expect(calls.at(-1)).toEqual([
      200,
      { op: "setColor", ref: 4, value: "#00ff00" },
    ]);
    expect(
      await runPage(send, { op: "scroll", ref: "5:3:4", left: 0, top: 100 }),
    ).toMatchObject({ moved: true });
    expect(calls.at(-1)).toEqual([
      200,
      { op: "scroll", ref: 4, left: 0, top: 100 },
    ]);
    documents[200].answer = (request) =>
      request.op === "scrollIntoView"
        ? { ok: true, moved: false, viewport: viewport(200, 100) }
        : undefined;
    expect(await runPage(send, { op: "scrollIntoView", ref: "5:3:4" })).toEqual(
      { ok: true, moved: true, viewport: viewport() },
    );
    documents[200].answer = (request) =>
      request.op === "syntheticClick"
        ? {
            ok: true,
            ref: request.ref,
            target: "button",
            dispatched: [{ type: "dblclick", canceled: false }],
            focused: "body",
          }
        : undefined;
    expect(
      await runPage(send, {
        op: "syntheticClick",
        ref: "5:3:4",
        action: "double_click",
        modifiers: ["shift"],
      }),
    ).toMatchObject({ ok: true, ref: "5:3:4", target: "button" });
    expect(calls.at(-1)).toEqual([
      200,
      {
        op: "syntheticClick",
        ref: 4,
        action: "double_click",
        modifiers: ["shift"],
      },
    ]);
    let files = [
      { name: "a.txt", mimeType: "text/plain", lastModified: 1, data: "YQ==" },
    ];
    documents[200].answer = (request) =>
      request.op === "upload"
        ? {
            ok: true,
            ref: request.ref,
            target: "input#file",
            via: "input",
            files: [{ name: "a.txt", size: 1, type: "text/plain" }],
            dispatched: [{ type: "change", canceled: false }],
          }
        : undefined;
    expect(
      await runPage(send, { op: "upload", ref: "5:3:4", files }),
    ).toMatchObject({ ok: true, ref: "5:3:4", via: "input" });
    expect(calls.at(-1)).toEqual([200, { op: "upload", ref: 4, files }]);
    expect(await runPage(send, { op: "inspect", ref: "5.4" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/must look like 12/),
    });
  });
});

describe("runPage waitFor", () => {
  let request = {
    op: "waitFor" as const,
    text: "Ready",
    selector: null,
  };
  let found = (ref: number, top: number) => ({
    ok: true as const,
    url: "u",
    title: "t",
    match: {
      ref,
      tag: "p",
      role: "paragraph",
      name: "",
      rect: rect(0, top, 10, 10),
      inViewport: true,
      text: "Ready now",
    },
  });
  let none = { ok: true as const, url: "u", title: "t", match: null };

  test("the top frame's match wins over a frame's", async () => {
    documents[0].answer = (asked) =>
      asked.op === "waitFor" ? found(7, 0) : undefined;
    documents[100].answer = (asked) =>
      asked.op === "waitFor" ? found(2, 0) : undefined;
    expect(await runPage(send, request)).toMatchObject({
      ok: true,
      pending: null,
      match: { ref: "7", text: "Ready now" },
    });
  });

  test("a match inside a nested frame gets its path and top-frame rect", async () => {
    documents[0].answer = (asked) =>
      asked.op === "waitFor" ? { ...none, url: "top" } : undefined;
    documents[100].answer = (asked) =>
      asked.op === "waitFor" ? none : undefined;
    documents[200].answer = (asked) =>
      asked.op === "waitFor" ? found(9, 5) : undefined;
    expect(await runPage(send, request)).toMatchObject({
      ok: true,
      url: "top",
      match: { ref: "5:3:9", rect: { left: 30, top: 135 }, text: "Ready now" },
    });
    expect(
      calls.filter(([, asked]) => asked.op === "waitFor").map(([id]) => id),
    ).toEqual([0, 100, 200]);
  });

  test("no match anywhere is an empty answer, and a frame that does not answer is skipped", async () => {
    documents[0].answer = (asked) =>
      asked.op === "waitFor" ? none : undefined;
    documents[100].answer = (asked) =>
      asked.op === "waitFor" ? { ok: false, error: "busy" } : undefined;
    documents[200].answer = (asked) =>
      asked.op === "waitFor" ? none : undefined;
    expect(await runPage(send, request)).toEqual({
      ok: true,
      url: "u",
      title: "t",
      match: null,
      pending: null,
    });
  });

  test("a top frame with no content script or no answer is pending, not failed", async () => {
    documents[0].answer = () => ({
      ok: false,
      error: "no content script answered in tab 5",
      unreachable: true,
    });
    expect(await runPage(send, request)).toEqual({
      ok: true,
      url: null,
      title: null,
      match: null,
      pending: "no content script answered in tab 5",
    });

    documents[0].answer = (asked) =>
      asked.op === "waitFor"
        ? { ok: false, error: "no answer within 15 s", timeout: true }
        : undefined;
    expect(await runPage(send, request)).toMatchObject({
      ok: true,
      pending: "no answer within 15 s",
    });
  });

  test("any other top-frame failure, such as a bad selector, fails", async () => {
    documents[0].answer = (asked) =>
      asked.op === "waitFor"
        ? { ok: false, error: '"li[" is not a valid CSS selector' }
        : undefined;
    expect(
      await runPage(send, { op: "waitFor", text: null, selector: "li[" }),
    ).toEqual({ ok: false, error: '"li[" is not a valid CSS selector' });
  });
});
