import { parse } from "acorn";
import type { JavascriptResult } from "../shared/commands";
import type { Failure } from "../shared/protocol";
import { type Send, parsePath, walkPath, withTimeout } from "./frames";

// As long as a content send: alert() or a promise that never settles must not hold the background's only poll.
export let javascriptTimeoutMs = 15000;

// The body of an async function that returns the code's last expression, so top-level await works and the value comes back as in a REPL.
export function replBody(code: string) {
  let program;

  try {
    program = parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
    });
  } catch (error) {
    throw new Error(`SyntaxError: ${(error as Error).message}`);
  }

  let last = program.body.at(-1);

  if (last?.type !== "ExpressionStatement") return code;

  let { start, end } = last.expression;
  return `${code.slice(0, last.start)}return (${code.slice(start, end)});${code.slice(last.end)}`;
}

// Injected into the page's main world, so it is serialized from its source: it must reference nothing outside itself.
export async function evaluate(body: string) {
  let describe = (error: unknown) =>
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  let AsyncFunction = (async () => {}).constructor as FunctionConstructor;
  let run;

  try {
    run = new AsyncFunction(body);
  } catch (error) {
    let blocked = error instanceof EvalError;
    return {
      ok: false as const,
      error: blocked
        ? `the page's Content-Security-Policy blocks running code here (no 'unsafe-eval'): ${describe(error)}`
        : `the page could not compile the code: ${describe(error)}`,
    };
  }

  let value;

  try {
    value = await run();
  } catch (error) {
    return { ok: false as const, error: `the code threw ${describe(error)}` };
  }

  try {
    return { ok: true as const, json: JSON.stringify(value) ?? null };
  } catch (error) {
    return {
      ok: false as const,
      error: `the result is not JSON-serializable: ${describe(error)}`,
    };
  }
}

// frame is an iframe ref whose document runs the code; null runs it in the top frame.
export async function runJavascript(
  tabId: number,
  send: Send,
  code: string,
  frame: string | null,
): Promise<JavascriptResult | Failure> {
  let body = replBody(code);
  let frameId = 0;

  if (frame !== null) {
    let path = parsePath(frame);
    let walk = await walkPath(send, [...path.frames, path.local], false);

    if (walk.sandboxed)
      return {
        ok: false,
        error: `the frame of iframe ${frame} is sandboxed without allow-scripts, so no code runs there`,
      };

    frameId = walk.frameId;
  }

  let injected = browser.scripting
    .executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      func: evaluate,
      args: [body],
    })
    .then(([injection]) => {
      // Safari 17.4+ reports a failed injection in error, which @types/chrome leaves out.
      let error = (injection as { error?: unknown } | undefined)?.error;

      if (error !== undefined)
        return { ok: false as const, error: `injection failed: ${error}` };

      if (injection?.result?.ok === undefined)
        return {
          ok: false as const,
          error: `injection answered ${JSON.stringify(injection)} instead of a result`,
        };

      return injection.result;
    });
  return await withTimeout(
    injected,
    javascriptTimeoutMs,
    `the code did not finish within ${javascriptTimeoutMs / 1000} s; it may be waiting on a promise that never settles, or a dialog such as alert() is open`,
  );
}
