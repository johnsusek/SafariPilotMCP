// README charts from layer2 passes: median time and input tokens per task, and mean time per tool call across every run. Each pass folder needs the
// runs.json its --analyze wrote; a task in a later folder replaces the same task from an earlier one, and tasks only one browser ran are left out.
// Renders with Google Chrome headless and cwebp.
// Run: node scripts/compare/charts.ts --out docs/benchmark [--skip flights] notes/bench/<date>/layer2 [more pass folders]
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { loadEvents, quantile, toolCalls } from "./agent.ts";

let { values, positionals } = parseArgs({
  options: { out: { type: "string" }, skip: { type: "string", default: "" } },
  allowPositionals: true,
});
if (!values.out || !positionals.length)
  throw new Error(
    "usage: charts.ts --out <dir> [--skip task,task] <layer2 folder>...",
  );

let taskNames: Record<string, string> = {
  form: "Signup form",
  table: "500-row table",
  results: "Compare 8 results",
  reading: "Compare 14 articles",
  delayed: "Delayed content",
  frame: "Cross-origin iframe",
  editor: "Rich text editor",
  dialog: "Confirm dialog",
  upload: "File upload",
  wikipedia: "Wikipedia",
  hackernews: "Hacker News",
  github: "GitHub",
  httpbin: "httpbin form",
  ytsearch: "YouTube search",
  ytcomments: "YouTube comments",
  ytdesc: "YouTube description",
  ytplayer: "YouTube player",
  doordash: "DoorDash",
  apple: "Apple Store",
  maps: "Google Maps",
  flights: "Google Flights",
  mdn: "MDN",
  bluesky: "Bluesky",
  allrecipes: "Allrecipes",
  irs: "IRS PDF",
};

// Claude in Chrome folds clicks, typing, screenshots and scrolling into one computer tool; each maps to SafariPilot's own tool for that action.
let toolName = (name: string, input: any) => {
  let short = name.split("__").at(-1)!;
  if (short != "computer")
    return (
      {
        tabs_create_mcp: "tab_create",
        tabs_close_mcp: "tab_close",
        javascript_tool: "javascript",
      }[short] ?? short
    );

  if (["left_click", "double_click", "triple_click"].includes(input?.action))
    return "click";
  if (input?.action == "type") return "key";
  if (["key", "screenshot", "scroll"].includes(input?.action))
    return input.action;
  return null;
};
// Tools both browsers have, where a call does the same job on each.
let comparedTools = [
  "tab_create",
  "navigate",
  "click",
  "form_input",
  "key",
  "find",
  "read_page",
  "get_page_text",
  "javascript",
  "screenshot",
  "scroll",
  "file_upload",
  "tab_close",
];

let runsByTask = new Map<string, { run: any; folder: string }[]>();

for (let folder of positionals) {
  let saved = JSON.parse(await readFile(join(folder, "runs.json"), "utf8"));
  let both = Object.values(Object.groupBy(saved, (run: any) => run.task))
    .filter((group) => new Set(group!.map((run) => run.browser)).size == 2)
    .map((group) => group![0].task)
    .filter((task) => !values.skip.split(",").includes(task));

  for (let task of both)
    runsByTask.set(
      task,
      saved
        .filter((run: any) => run.task == task)
        .map((run: any) => ({ run, folder })),
    );
}

let runs = [...runsByTask.values()].flat();
let toolTimes: Record<string, Record<string, number[]>> = {};

for (let { run, folder } of runs) {
  let events = await loadEvents(
    join(folder, `${run.task}-${run.browser}-${run.run}.jsonl`),
  );

  for (let call of toolCalls(events)) {
    let name = toolName(call.name, call.input);
    if (!name || call.isError) continue;
    toolTimes[name] ??= { safaripilot: [], chrome: [] };
    toolTimes[name][run.browser].push(call.toolMs);
  }
}

let median = (task: string, browser: string, pick: (run: any) => number) =>
  quantile(
    runsByTask
      .get(task)!
      .filter(({ run }) => run.browser == browser)
      .map(({ run }) => pick(run)),
    0.5,
  )!;
let mean = (list: number[]) =>
  list.reduce((sum, value) => sum + value, 0) / list.length;

let taskRows = (pick: (run: any) => number) =>
  [...runsByTask.keys()].map((task) => ({
    label: taskNames[task] ?? task,
    safaripilot: median(task, "safaripilot", pick),
    chrome: median(task, "chrome", pick),
  }));
let timeRows = taskRows((run) => run.wallMs);
let tokenRows = taskRows((run) => run.inputTokens);
// A mean of fewer than 5 calls says little, so those tools are left out.
let toolRows = comparedTools
  .filter(
    (name) =>
      toolTimes[name]?.safaripilot.length >= 5 &&
      toolTimes[name]?.chrome.length >= 5,
  )
  .map((name) => ({
    label: name,
    safaripilot: mean(toolTimes[name].safaripilot),
    chrome: mean(toolTimes[name].chrome),
  }));

let total = (browser: string, pick: (run: any) => number) =>
  runs
    .filter(({ run }) => run.browser == browser)
    .reduce((sum, { run }) => sum + pick(run), 0);
let totals = Object.fromEntries(
  ["safaripilot", "chrome"].map((browser) => [
    browser,
    {
      runs: runs.filter(({ run }) => run.browser == browser).length,
      passed: runs.filter(({ run }) => run.browser == browser && run.ok).length,
      seconds: Math.round(total(browser, (run) => run.wallMs) / 1000),
      inputTokens: total(browser, (run) => run.inputTokens),
      outputTokens: total(browser, (run) => run.outputTokens),
    },
  ]),
);

let times = "×";
let speedup = (row: { safaripilot: number; chrome: number }) =>
  row.chrome / row.safaripilot;
let seconds = (ms: number) => `${ms / 1000} s`;
let milliseconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${ms / 1000} s`);

type Row = { label: string; safaripilot: number; chrome: number; note: string };
type Chart = {
  title: string;
  caption: string;
  rows: Row[];
  ticks: number[];
  format: (value: number) => string;
  log?: boolean;
  mono?: boolean;
};

let charts: Record<string, Chart> = {
  tasks: {
    title: `Per task: SafariPilot finished all ${timeRows.length} faster, up to ${Math.max(...timeRows.map(speedup)).toFixed(1)}${times}`,
    caption: "median of 3 to 5 runs",
    rows: timeRows
      .map((row) => ({ ...row, note: `${speedup(row).toFixed(1)}${times}` }))
      .sort((left, right) => speedup(right) - speedup(left)),
    ticks: [0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000],
    format: seconds,
  },
  tokens: {
    title: `Input tokens: fewer on ${tokenRows.filter((row) => row.safaripilot < row.chrome).length} of ${tokenRows.length} tasks`,
    caption: "median per run, cache reads included",
    rows: tokenRows
      .map((row) => {
        let change = Math.round((row.safaripilot / row.chrome - 1) * 100);
        return { ...row, note: `${change > 0 ? "+" : ""}${change}%` };
      })
      .sort(
        (left, right) =>
          left.safaripilot / left.chrome - right.safaripilot / right.chrome,
      ),
    ticks: [0, 100_000, 200_000, 300_000, 400_000, 500_000],
    format: (value) => (value ? `${value / 1000}K` : "0"),
  },
  tools: {
    title: `Per tool: SafariPilot is faster on all ${toolRows.length}, up to ${Math.round(Math.max(...toolRows.map(speedup)))}${times}`,
    caption: "mean per call in the task runs, log scale",
    rows: toolRows
      .map((row) => ({
        ...row,
        note: `${speedup(row).toFixed(speedup(row) < 10 ? 1 : 0)}${times}`,
      }))
      .sort((left, right) => speedup(right) - speedup(left)),
    ticks: [30, 100, 300, 1000, 3000, 10_000],
    format: milliseconds,
    log: true,
    mono: true,
  },
};

let themes = {
  light: {
    background: "#ffffff",
    text: "#1f2328",
    muted: "#59636e",
    grid: "#e6e8eb",
    line: "#d1d5da",
    safaripilot: "#e5533d",
    chrome: "#9aa3ae",
  },
  dark: {
    background: "#0d1117",
    text: "#e6edf3",
    muted: "#9198a1",
    grid: "#21262d",
    line: "#3d444d",
    safaripilot: "#f0614b",
    chrome: "#7d8590",
  },
};

let page = (chart: Chart, theme: (typeof themes)["light"]) => {
  let low = chart.ticks[0];
  let high = chart.ticks.at(-1)!;
  let scale = chart.log ? Math.log : (value: number) => value;
  let position = (value: number) =>
    ((scale(value) - scale(low)) / (scale(high) - scale(low))) * 100;
  let ticks = chart.ticks
    .map(
      (tick) =>
        `<i style="left:${position(tick)}%"><span>${chart.format(tick)}</span></i>`,
    )
    .join("");
  let rows = chart.rows
    .map((row) => {
      let left = position(Math.min(row.safaripilot, row.chrome));
      let right = position(Math.max(row.safaripilot, row.chrome));
      return `<div class="row"><div class="label">${row.label}</div><div class="track"><b style="left:${left}%;width:${right - left}%"></b><u class="chrome" style="left:${position(row.chrome)}%"></u><u class="safaripilot" style="left:${position(row.safaripilot)}%"></u></div><div class="note">${row.note}</div></div>`;
    })
    .join("");

  return `<!doctype html><meta charset="utf-8"><style>
:root { --label: 200px; --note: 72px; }
* { margin: 0; box-sizing: border-box; }
body { background: ${theme.background}; color: ${theme.text}; font: 15px -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif; padding: 24px; width: 868px; }
h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
.legend { display: flex; gap: 20px; align-items: center; color: ${theme.muted}; margin: 10px 0 18px; }
.legend span { display: flex; align-items: center; gap: 8px; }
.legend .caption { margin-left: auto; }
.dot { width: 12px; height: 12px; border-radius: 50%; }
.plot { position: relative; padding-bottom: 28px; }
.grid { position: absolute; top: 0; bottom: 0; left: var(--label); right: var(--note); }
.grid i { font-style: normal; position: absolute; top: 0; bottom: 22px; border-left: 1px solid ${theme.grid}; }
.grid span { position: absolute; bottom: -22px; transform: translateX(-50%); color: ${theme.muted}; font-size: 13px; white-space: nowrap; }
.row { display: grid; grid-template-columns: var(--label) 1fr var(--note); align-items: center; height: 34px; position: relative; }
.label { ${chart.mono ? `font: 15px "SF Mono", Menlo, monospace;` : ""} }
.track { position: relative; height: 100%; }
.track b { position: absolute; top: 50%; height: 4px; margin-top: -2px; background: ${theme.line}; border-radius: 2px; }
.track u { position: absolute; top: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; }
.chrome { background: ${theme.chrome}; }
.safaripilot { background: ${theme.safaripilot}; }
.note { text-align: right; font-variant-numeric: tabular-nums; }
</style>
<h1>${chart.title}</h1>
<div class="legend"><span><i class="dot safaripilot"></i>SafariPilot</span><span><i class="dot chrome"></i>Claude in Chrome</span><span class="caption">${chart.caption}</span></div>
<div class="plot"><div class="grid">${ticks}</div>${rows}</div>`;
};

let run = promisify(execFile);
let chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let scratch = await mkdtemp(join(tmpdir(), "charts-"));

for (let [name, chart] of Object.entries(charts)) {
  let low = chart.ticks[0];
  let high = chart.ticks.at(-1)!;
  let outside = chart.rows.filter(
    (row) =>
      Math.min(row.safaripilot, row.chrome) < low ||
      Math.max(row.safaripilot, row.chrome) > high,
  );
  if (outside.length)
    throw new Error(
      `${name}: ${outside.map((row) => row.label).join(", ")} outside the axis`,
    );

  for (let [themeName, theme] of Object.entries(themes)) {
    let html = join(scratch, `${name}-${themeName}.html`);
    let png = join(scratch, `${name}-${themeName}.png`);
    await writeFile(html, page(chart, theme));
    // Rendered into a window taller than the chart, then trimmed to its content and given back an even margin.
    await run(chrome, [
      "--headless",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      `--window-size=916,${chart.rows.length * 34 + 300}`,
      `--screenshot=${png}`,
      `file://${html}`,
    ]);
    await run("magick", [
      png,
      "-trim",
      "+repage",
      "-bordercolor",
      theme.background,
      "-border",
      "48",
      png,
    ]);
    await run("cwebp", [
      "-quiet",
      "-q",
      "90",
      png,
      "-o",
      join(values.out, `${name}-${themeName}.webp`),
    ]);
  }
}

await rm(scratch, { recursive: true });
console.log(JSON.stringify(totals, null, 2));
console.table(
  charts.tasks.rows.map((row) => ({
    task: row.label,
    safaripilot: row.safaripilot,
    chrome: row.chrome,
    speedup: row.note,
  })),
);
