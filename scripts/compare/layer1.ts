// Per-tool latency, SafariPilot against Claude in Chrome, both driven by the same isolated `claude -p`: one session per tool and browser, which
// opens the test page, calls the tool REPS times in a row and closes its tab. The first call of each session is a warm-up and left out.
// Needs the test page served (npm --prefix web run testpage), both browsers connected and SAFARIPILOT_CREDENTIAL set to an approved client's credential.
// Run: node scripts/compare/layer1.ts --out notes/bench/<date>/layer1 [--reps 15] [--ops click,find] [--browsers chrome] [--model sonnet] [--analyze]
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type Browser,
  loadEvents,
  quantile,
  requireTestPage,
  runAgent,
  saveEvents,
  type Timed,
  toolCalls,
} from "./agent.ts";

let url = "http://127.0.0.1:8765/";
let findButton = "Use find to get the ref of the button named Button.";
let clickText =
  "Use find to get the ref of the text field named Text, then click it once.";

let ops: Record<
  string,
  { setup?: string; safaripilot: string; chrome: string }
> = {
  navigate: {
    safaripilot: `navigate to ${url}?bench`,
    chrome: `navigate to ${url}?bench`,
  },
  click: {
    setup: findButton,
    safaripilot: "click with that button's ref",
    chrome: "computer with action left_click and that button's ref",
  },
  form_input: {
    setup: "Use find to get the ref of the text field named Text.",
    safaripilot: 'form_input on that field with value "bench"',
    chrome: 'form_input on that field with value "bench"',
  },
  key: {
    setup: clickText,
    safaripilot: 'key with text "x" and no ref',
    chrome: 'computer with action type and text "x"',
  },
  read_page: {
    safaripilot: 'read_page with filter "all"',
    chrome: 'read_page with filter "all"',
  },
  get_page_text: { safaripilot: "get_page_text", chrome: "get_page_text" },
  find: {
    safaripilot: 'find with name "Button" and role "button"',
    chrome: 'find with query "Button button"',
  },
  screenshot: {
    safaripilot: "screenshot",
    chrome: "computer with action screenshot",
  },
  scroll: {
    safaripilot: 'scroll with direction "down" and amount 3',
    chrome:
      'computer with action scroll, scroll_direction "down", scroll_amount 3 and coordinate [400, 300]',
  },
  javascript: {
    safaripilot: 'javascript with text "document.title"',
    chrome:
      'javascript_tool with action "javascript_exec" and text "document.title"',
  },
};

let open = {
  safaripilot: `Call tab_create with url ${url}.`,
  chrome: `Call tabs_context_mcp with createIfEmpty true, then navigate its tab to ${url}.`,
};

let computerActions: Record<string, string> = {
  left_click: "click",
  type: "key",
  key: "key",
  screenshot: "screenshot",
  scroll: "scroll",
};

// Names a call by the op it measures, so Chrome's computer actions line up with SafariPilot's separate tools. Measured navigates load ?bench,
// which keeps Chrome's tab-opening navigate out of them.
let opOf = (name: string, input: any) => {
  let tool = name.replace(/^mcp__.+?__/, "");
  if (tool == "navigate" && !String(input.url).includes("?bench"))
    return "open";
  if (tool == "computer")
    return computerActions[input.action] ?? `computer:${input.action}`;
  if (tool == "javascript_tool") return "javascript";
  return tool;
};

let summarize = (browser: string, op: string, events: Timed[]) => {
  let measured = toolCalls(events)
    .filter((call) => opOf(call.name, call.input) == op)
    .slice(1);
  let times = measured.map((call) => call.toolMs);
  let tokens = measured.flatMap((call) =>
    call.resultTokens == null ? [] : [call.resultTokens],
  );
  let result = events.find((each) => each.event.type == "result")?.event;
  return {
    browser,
    op,
    calls: measured.length,
    errors: measured.filter((call) => call.isError).length,
    medianMs: quantile(times, 0.5),
    p90Ms: quantile(times, 0.9),
    medianTokens: quantile(tokens, 0.5),
    medianChars: quantile(
      measured.map((call) => call.resultChars),
      0.5,
    ),
    images: measured.reduce((sum, call) => sum + call.images, 0),
    sessionMs: result?.duration_ms ?? null,
    reply: result?.result?.slice(0, 120) ?? "no result event",
  };
};

let { values } = parseArgs({
  options: {
    out: { type: "string" },
    reps: { type: "string", default: "15" },
    ops: { type: "string" },
    browsers: { type: "string", default: "safaripilot,chrome" },
    model: { type: "string", default: "sonnet" },
    analyze: { type: "boolean", default: false },
  },
});
if (!values.out) throw new Error("--out is required");

let out = values.out;
let reps = Number(values.reps) + 1;
let names = values.ops?.split(",") ?? Object.keys(ops);
let browsers = values.browsers.split(",") as Browser[];
let unknown = names.filter((name) => !ops[name]);
if (unknown.length) throw new Error(`unknown ops: ${unknown.join(", ")}`);

await mkdir(out, { recursive: true });

if (!values.analyze) {
  await requireTestPage(url);

  for (let [index, op] of names.entries()) {
    // Alternates which browser goes first so drift over the pass lands on both.
    let order = index % 2 ? [...browsers].reverse() : browsers;

    for (let browser of order) {
      let spec = ops[op];
      let steps = [
        open[browser],
        spec.setup,
        `Call ${spec[browser]}, ${reps} times in a row, ignoring what each returns unless it is an error.`,
        "Close the tab you opened, then reply DONE.",
      ].filter(Boolean);
      let prompt = [
        "This is a latency benchmark, so follow the steps exactly. Make one tool call per message, never several at once, and write no text until the end.",
        ...steps.map((step, number) => `${number + 1}. ${step}`),
      ].join("\n");
      console.log(`${browser} ${op}`);
      let { events } = await runAgent(browser, prompt, values.model);
      await saveEvents(join(out, `${browser}-${op}.jsonl`), events);
    }
  }
}

let rows = [];

for (let file of (await readdir(out))
  .filter((name) => name.endsWith(".jsonl"))
  .sort()) {
  let [browser, op] = file.replace(/\.jsonl$/, "").split(/-(.+)/);
  rows.push(summarize(browser, op, await loadEvents(join(out, file))));
}

await writeFile(
  join(out, "summary.json"),
  JSON.stringify(rows, null, 2) + "\n",
);
console.table(rows.map(({ reply, ...row }) => row));
