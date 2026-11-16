import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type Browser = "safaripilot" | "chrome";
export type Timed = { ms: number; event: any };
export type ToolCall = {
  name: string;
  input: any;
  ms: number;
  toolMs: number;
  isError: boolean;
  resultChars: number;
  // The result's text parts joined, so a checker can tell an answer was read from the page rather than made up.
  text: string;
  images: number;
  resultTokens: number | null;
};

let credential = process.env.SAFARIPILOT_CREDENTIAL;
if (!credential)
  throw new Error(
    "SAFARIPILOT_CREDENTIAL is not set: without it every SafariPilot session waits for approval",
  );

let safaripilot = {
  mcpServers: {
    safaripilot: {
      type: "stdio",
      command:
        "/Applications/SafariPilot.app/Contents/SharedSupport/safaripilot",
      args: ["mcp"],
      env: { SAFARIPILOT_CREDENTIAL: credential },
    },
  },
};

let browserFlags = {
  safaripilot: ["--no-chrome", "--mcp-config", JSON.stringify(safaripilot)],
  chrome: ["--chrome", "--mcp-config", JSON.stringify({ mcpServers: {} })],
};

let browserTools = {
  safaripilot: "mcp__safaripilot",
  chrome: "mcp__claude-in-chrome",
};

// A cwd under ~ loads ~/.claude/CLAUDE.md, project memory and git status whatever --setting-sources says, so each run starts in a fresh dir outside ~.
// readDirs turns on the Read tool for those folders, since Claude in Chrome's file_upload takes only files Read may open; both browsers get it.
// A run still going after timeoutMs is killed and comes back with timedOut set, so one stuck run can't stall a pass.
export let runAgent = async (
  browser: Browser,
  prompt: string,
  model: string,
  { timeoutMs = 10 * 60_000, readDirs = [] as string[] } = {},
) => {
  let cwd = await mkdtemp(join(tmpdir(), "compare-"));
  if (cwd.startsWith(homedir()))
    throw new Error(
      `run dir ${cwd} is under ~, where ~/.claude/CLAUDE.md would load`,
    );

  let args = [
    "-p",
    prompt,
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    ...browserFlags[browser],
    "--tools",
    readDirs.length ? "Read" : "",
    "--allowedTools",
    browserTools[browser],
    ...(readDirs.length ? ["Read"] : []),
    ...readDirs.flatMap((dir) => ["--add-dir", dir]),
    "--permission-prompts",
    "none",
    "--model",
    model,
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  let child = spawn("claude", args, {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let closed = once(child, "close");
  let start = performance.now();
  let events: Timed[] = [];
  let timedOut = false;

  let timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  for await (let line of createInterface({ input: child.stdout })) {
    if (!line.trim()) continue;
    events.push({
      ms: Math.round(performance.now() - start),
      event: JSON.parse(line),
    });
  }

  await closed;
  clearTimeout(timer);
  return { events, timedOut };
};

export let saveEvents = (path: string, events: Timed[]) =>
  writeFile(path, events.map((each) => JSON.stringify(each)).join("\n") + "\n");

export let loadEvents = async (path: string) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Timed);

export let requireTestPage = async (url: string) => {
  let page = await fetch(url).catch(() => null);
  if (!page?.ok)
    throw new Error(
      `test page not served at ${url}: run npm --prefix web run testpage`,
    );
};

export let quantile = (values: number[], fraction: number) => {
  if (!values.length) return null;

  let sorted = [...values].sort((left, right) => left - right);
  let position = (sorted.length - 1) * fraction;
  let low = Math.floor(position);
  return Math.round(
    sorted[low] +
      (sorted[Math.ceil(position)] - sorted[low]) * (position - low),
  );
};

// Each tool call's time runs from its tool_use line to its tool_result line. Its result's tokens are the growth of the next request's input past
// the calling message's own output, known only when that message made a single call.
export let toolCalls = (events: Timed[]) => {
  let messages: {
    id: string;
    input: number;
    output: number;
    toolIds: string[];
  }[] = [];
  let uses = new Map<string, { name: string; input: any; ms: number }>();
  let results = new Map<string, { ms: number; block: any }>();

  for (let { ms, event } of events) {
    let content = event.message?.content;
    if (!Array.isArray(content)) continue;

    if (event.type == "assistant") {
      let usage = event.message.usage;
      let message = messages.find((each) => each.id == event.message.id);

      if (!message) {
        message = {
          id: event.message.id,
          input:
            usage.input_tokens +
            usage.cache_read_input_tokens +
            usage.cache_creation_input_tokens,
          output: usage.output_tokens,
          toolIds: [],
        };
        messages.push(message);
      }

      for (let block of content.filter(
        (each: any) => each.type == "tool_use",
      )) {
        uses.set(block.id, { name: block.name, input: block.input, ms });
        message.toolIds.push(block.id);
      }
    }

    for (let block of content.filter((each: any) => each.type == "tool_result"))
      results.set(block.tool_use_id, { ms, block });
  }

  let resultTokens = new Map<string, number>();

  messages.forEach((message, index) => {
    let next = messages[index + 1];
    if (next && message.toolIds.length == 1)
      resultTokens.set(
        message.toolIds[0],
        next.input - message.input - message.output,
      );
  });

  return [...uses].flatMap(([id, use]): ToolCall[] => {
    let result = results.get(id);
    if (!result) return [];

    let parts = Array.isArray(result.block.content)
      ? result.block.content
      : [{ type: "text", text: String(result.block.content ?? "") }];
    let text = parts.map((part: any) => part.text ?? "").join("\n");
    let images = parts.filter((part: any) => part.type == "image").length;
    return [
      {
        ...use,
        toolMs: result.ms - use.ms,
        isError: !!result.block.is_error,
        resultChars: parts.reduce(
          (sum: number, part: any) => sum + (part.text?.length ?? 0),
          0,
        ),
        text,
        images,
        resultTokens: resultTokens.get(id) ?? null,
      },
    ];
  });
};
