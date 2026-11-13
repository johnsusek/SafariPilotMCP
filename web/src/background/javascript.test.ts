import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ContentRequest, FrameEntry } from "../shared/protocol";
import type { Send } from "./frames";
import {
  evaluate,
  javascriptTimeoutMs,
  replBody,
  runJavascript,
} from "./javascript";

let viewport = {
  innerWidth: 1000,
  innerHeight: 800,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 2,
  visualScale: 1,
  visualOffsetLeft: 0,
  visualOffsetTop: 0,
  visualWidth: 1000,
  visualHeight: 800,
  clientWidth: 1000,
  clientHeight: 800,
};
let box = { left: 0, top: 0, width: 300, height: 200 };
let iframe = (ref: number, frameId: number, sandbox: string | null) =>
  ({
    ref,
    frameId,
    src: "https://child.test/",
    sandbox,
    box,
    clip: box,
    transformed: false,
  }) as FrameEntry;

// The top frame holds iframe 5 (frame 41) and a sandboxed iframe 6 (frame 42); frame 41 holds iframe 3 (frame 43).
let frames: Record<number, FrameEntry[]> = {
  0: [iframe(5, 41, null), iframe(6, 42, "allow-forms")],
  41: [iframe(3, 43, "allow-scripts")],
};
let send: Send = async (frameId, request: ContentRequest) => {
  if (request.op !== "frameBox") return { ok: false, error: "unhandled" };

  let frame = frames[frameId]?.find((each) => each.ref === request.ref);

  if (!frame) return { ok: false, error: `ref ${request.ref} is unknown` };

  return { ok: true, frame, moved: false, viewport, origin: 1 };
};

let executeScript: ReturnType<typeof vi.fn>;

// Runs the injected function here, as Safari would in the page, and answers with InjectionResults.
let injecting = () =>
  vi.fn(
    async (injection: {
      target: { frameIds: number[] };
      func: (body: string) => Promise<unknown>;
      args: [string];
    }) => [
      {
        frameId: injection.target.frameIds[0],
        result: await injection.func(...injection.args),
      },
    ],
  );

beforeEach(() => {
  executeScript = injecting();
  vi.stubGlobal("browser", { scripting: { executeScript } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

let run = (code: string, frame: string | null = null) =>
  runJavascript(9, send, code, frame);

describe("replBody", () => {
  test("returns the last expression statement", () => {
    expect(replBody("let x = 2;\nx * 3;")).toBe("let x = 2;\nreturn (x * 3);");
    expect(replBody("document.title")).toBe("return (document.title);");
    expect(replBody("a, b // trailing")).toBe("return (a, b); // trailing");
  });

  test("takes top-level await", () => {
    expect(replBody("await fetch(url)")).toBe("return (await fetch(url));");
  });

  test("leaves code that ends in a declaration or block alone", () => {
    expect(replBody("let x = 1")).toBe("let x = 1");
    expect(replBody("if (a) { b }")).toBe("if (a) { b }");
  });

  test("syntax errors fail before anything is injected", () => {
    expect(() => replBody("let = ;")).toThrow(/^SyntaxError: /);
    expect(() => replBody("return 1")).toThrow(/^SyntaxError: /);
  });
});

describe("evaluate", () => {
  test("is self-contained, since it is serialized from its source", async () => {
    let rebuilt = new Function(`return ${evaluate.toString()}`)();
    expect(await rebuilt("return (1 + 1);")).toEqual({ ok: true, json: "2" });
  });

  test("errors and unserializable values fail", async () => {
    expect(await evaluate("return (")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^the page could not compile the code: /),
    });
    let circular = await evaluate(
      "let loop = {}; loop.loop = loop; return loop",
    );
    expect(circular).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^the result is not JSON-serializable: /),
    });
  });
});

describe("runJavascript", () => {
  test("runs in the top frame's main world and returns JSON", async () => {
    expect(await run("let item = { a: [1, 'b'] }; item")).toEqual({
      ok: true,
      json: '{"a":[1,"b"]}',
    });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 9, frameIds: [0] },
      world: "MAIN",
      func: evaluate,
      args: ["let item = { a: [1, 'b'] }; return (item);"],
    });
  });

  test("awaits top-level await and the last expression's promise", async () => {
    expect(
      await run("let value = await Promise.resolve(2); value + 1"),
    ).toEqual({ ok: true, json: "3" });
    expect(await run("Promise.resolve('done')")).toEqual({
      ok: true,
      json: '"done"',
    });
  });

  test("undefined comes back as null json", async () => {
    expect(await run("let x = 1")).toEqual({ ok: true, json: null });
    expect(await run("() => 1")).toEqual({ ok: true, json: null });
  });

  test("throws and rejections fail with the error", async () => {
    expect(await run("throw new TypeError('nope')")).toEqual({
      ok: false,
      error: "the code threw TypeError: nope",
    });
    expect(await run("await Promise.reject(new Error('later'))")).toEqual({
      ok: false,
      error: "the code threw Error: later",
    });
    expect(await run("throw 'plain'")).toEqual({
      ok: false,
      error: "the code threw plain",
    });
  });

  test("syntax errors fail without injecting", async () => {
    await expect(run("1 +")).rejects.toThrow(/^SyntaxError: /);
    expect(executeScript).not.toHaveBeenCalled();
  });

  test("a frame ref runs in that iframe's frame", async () => {
    await run("1", "5");
    expect(executeScript.mock.calls[0][0].target).toEqual({
      tabId: 9,
      frameIds: [41],
    });
    await run("1", "5:3");
    expect(executeScript.mock.calls[1][0].target).toEqual({
      tabId: 9,
      frameIds: [43],
    });
  });

  test("a frame sandboxed without allow-scripts or an unknown ref is refused", async () => {
    expect(await run("1", "6")).toEqual({
      ok: false,
      error:
        "the frame of iframe 6 is sandboxed without allow-scripts, so no code runs there",
    });
    await expect(run("1", "7")).rejects.toThrow("ref 7 is unknown");
    await expect(run("1", "5:")).rejects.toThrow(/must look like/);
    expect(executeScript).not.toHaveBeenCalled();
  });

  test("an injection error or a missing result fails loudly", async () => {
    executeScript.mockResolvedValueOnce([{ frameId: 0, error: "denied" }]);
    expect(await run("1")).toEqual({
      ok: false,
      error: "injection failed: denied",
    });
    executeScript.mockResolvedValueOnce([{ frameId: 0, result: {} }]);
    expect(await run("1")).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /^injection answered .* instead of a result$/,
      ),
    });
    executeScript.mockResolvedValueOnce([]);
    expect(await run("1")).toMatchObject({ ok: false });
  });

  test("code that never finishes times out", async () => {
    vi.useFakeTimers();
    executeScript.mockReturnValueOnce(new Promise(() => {}));
    let answer = run("await new Promise(() => {})");
    await vi.advanceTimersByTimeAsync(javascriptTimeoutMs);
    expect(await answer).toMatchObject({
      ok: false,
      timeout: true,
      error: expect.stringMatching(/did not finish within 15 s/),
    });
  });
});
