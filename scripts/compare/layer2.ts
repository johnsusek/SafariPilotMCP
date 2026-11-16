// End-to-end tasks, SafariPilot against Claude in Chrome, both driven by the same isolated `claude -p` with the same prompt: each run gets one
// task, and a checker grades the ANSWER line it ends with. Local tasks run on testpage/bench, whose pages show a code derived from what the agent
// entered; public ones are read-only. Needs the test page served (npm --prefix web run testpage), both browsers connected and
// SAFARIPILOT_CREDENTIAL set to an approved client's credential.
// Run: node scripts/compare/layer2.ts --out notes/bench/<date>/layer2 [--runs 5] [--tasks form,table] [--browsers chrome] [--model sonnet] [--analyze]
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { code } from "../../testpage/bench/code.js";
import { rows } from "../../testpage/bench/data.js";
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

type Expected = { hnUser: string; jqTag: string };
type Task = {
  prompt: (fixture: string) => string;
  check: (answer: string, expected: Expected) => boolean;
  // The run may read the fixture's folder, which Claude in Chrome needs to upload it.
  readsFixture?: boolean;
};

let site = "http://127.0.0.1:8765/bench";
let fixtureText = "SafariPilot benchmark fixture\n";

let tasks: Record<string, Task> = {
  form: {
    prompt: () =>
      `Go to ${site}/form.html and create an account for Ada Lovelace on the Team plan with 7 seats, the newsletter on and yearly billing. Report the confirmation code the page shows.`,
    check: (answer) =>
      answer.includes(
        code(JSON.stringify(["Ada Lovelace", "Team", "7", true, "yearly"])),
      ),
  },
  table: {
    prompt: () =>
      `Go to ${site}/table.html and report the email address of the person with ID 4271.`,
    check: (answer) =>
      answer
        .toLowerCase()
        .includes(rows().find((person) => person.id == 4271)!.email),
  },
  delayed: {
    prompt: () =>
      `Go to ${site}/delayed.html, load the report and report the quarterly total it shows.`,
    check: (answer) => /48,?213/.test(answer),
  },
  frame: {
    prompt: () =>
      `Go to ${site}/frame.html, set the nickname in the profile form to "blue heron" and save it. Report the code the form shows.`,
    check: (answer) => answer.includes(code("blue heron")),
  },
  editor: {
    prompt: () =>
      `Go to ${site}/editor.html, write the note "meet at noon" and submit it. Report the note code the page shows.`,
    check: (answer) => answer.includes(code("meet at noon")),
  },
  dialog: {
    prompt: () =>
      `Go to ${site}/dialog.html and delete the draft, confirming when asked. Report the receipt the page shows.`,
    check: (answer) => answer.includes("R-5531"),
  },
  upload: {
    readsFixture: true,
    prompt: (fixture) =>
      `Go to ${site}/upload.html and attach the file ${fixture}. Report the checksum the page shows.`,
    check: (answer) => answer.includes(code(fixtureText)),
  },
  wikipedia: {
    prompt: () =>
      "Go to https://en.wikipedia.org, use the site's search to find the article on the Rust programming language, and report who created the language, according to the article.",
    check: (answer) => /graydon hoare/i.test(answer),
  },
  hackernews: {
    prompt: () =>
      "Go to https://news.ycombinator.com/item?id=8863 and report the username of whoever wrote the first top-level comment.",
    check: (answer, expected) =>
      answer.toLowerCase().includes(expected.hnUser.toLowerCase()),
  },
  github: {
    prompt: () =>
      "Go to https://github.com/jqlang/jq and report the tag of its latest release.",
    check: (answer, expected) => answer.includes(expected.jqTag),
  },
  httpbin: {
    prompt: () =>
      "Go to https://httpbin.org/forms/post, order a large pizza with bacon and mushroom toppings for customer Grace Hopper, and submit it. Report the form fields the response echoes back.",
    check: (answer) =>
      ["grace hopper", "large", "bacon", "mushroom"].every((word) =>
        answer.toLowerCase().includes(word),
      ),
  },
};

let ending =
  "Use a new tab and close every tab you opened before you finish. End your reply with one final line of the form ANSWER: <your answer>.";

// The public answers are fetched once per pass and kept with its runs, since they can change between passes but not within one.
let expectedFor = async (out: string): Promise<Expected> => {
  let path = join(out, "expected.json");
  let saved = await readFile(path, "utf8").catch(() => null);
  if (saved) return JSON.parse(saved);

  let item = async (id: number) =>
    (
      await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
    ).json();
  let story = await item(8863);
  let release = await (
    await fetch("https://api.github.com/repos/jqlang/jq/releases/latest")
  ).json();
  let expected = {
    hnUser: (await item(story.kids[0])).by,
    jqTag: release.tag_name,
  };
  if (!expected.hnUser || !expected.jqTag)
    throw new Error(
      `could not fetch the public answers: ${JSON.stringify(expected)}`,
    );

  await writeFile(path, JSON.stringify(expected, null, 2) + "\n");
  return expected;
};

let grade = (task: string, events: Timed[], expected: Expected) => {
  let result = events.find((each) => each.event.type == "result")?.event;
  let answer =
    String(result?.result ?? "")
      .match(/^ANSWER:\s*(.+)$/im)?.[1]
      ?.trim() ?? "";
  let calls = toolCalls(events);
  let usage = result?.usage;
  // Time with any tool running: agents make several calls at once, so summing each call's time would count the overlap twice.
  let toolMs = 0;
  let reached = 0;

  for (let call of [...calls].sort((left, right) => left.ms - right.ms)) {
    let end = call.ms + call.toolMs;
    toolMs += Math.max(0, end - Math.max(call.ms, reached));
    reached = Math.max(reached, end);
  }

  let wallMs = result?.duration_ms ?? events.at(-1)?.ms ?? 0;

  return {
    ok: !!answer && tasks[task].check(answer, expected),
    timedOut: events.some((each) => each.event.type == "timeout"),
    answer,
    wallMs,
    toolMs,
    modelMs: wallMs - toolMs,
    turns: result?.num_turns ?? null,
    calls: calls.length,
    toolErrors: calls.filter((call) => call.isError).length,
    images: calls.reduce((sum, call) => sum + call.images, 0),
    inputTokens: usage
      ? usage.input_tokens +
        usage.cache_read_input_tokens +
        usage.cache_creation_input_tokens
      : null,
    outputTokens: usage?.output_tokens ?? null,
  };
};

let { values } = parseArgs({
  options: {
    out: { type: "string" },
    runs: { type: "string", default: "5" },
    tasks: { type: "string" },
    browsers: { type: "string", default: "safaripilot,chrome" },
    model: { type: "string", default: "sonnet" },
    analyze: { type: "boolean", default: false },
  },
});
if (!values.out) throw new Error("--out is required");

let out = values.out;
let names = values.tasks?.split(",") ?? Object.keys(tasks);
let browsers = values.browsers.split(",") as Browser[];
let unknown = names.filter((name) => !tasks[name]);
if (unknown.length) throw new Error(`unknown tasks: ${unknown.join(", ")}`);

await mkdir(out, { recursive: true });
let expected = await expectedFor(out);

if (!values.analyze) {
  await requireTestPage(`${site}/form.html`);
  // The real path, since /var is a symlink to /private/var and Claude in Chrome checks a file against the session's folders by real path.
  let fixture = join(
    await realpath(await mkdtemp(join(tmpdir(), "compare-fixture-"))),
    "bench-upload.txt",
  );
  await writeFile(fixture, fixtureText);

  for (let [index, task] of names.entries()) {
    for (let run = 1; run <= Number(values.runs); run++) {
      // Alternates which browser goes first so drift over the pass lands on both.
      let order = (index + run) % 2 ? [...browsers].reverse() : browsers;

      for (let browser of order) {
        // Runs already saved are kept, so a stopped pass picks up where it left off.
        let path = join(out, `${task}-${browser}-${run}.jsonl`);
        if (await stat(path).catch(() => null)) continue;

        let { events, timedOut } = await runAgent(
          browser,
          `${tasks[task].prompt(fixture)}\n${ending}`,
          values.model,
          tasks[task].readsFixture ? { readDirs: [dirname(fixture)] } : {},
        );
        if (timedOut)
          events.push({
            ms: events.at(-1)?.ms ?? 0,
            event: { type: "timeout" },
          });

        await saveEvents(path, events);
        let graded = grade(task, events, expected);
        console.log(
          `${task} ${browser} ${run}: ${graded.ok ? "pass" : "FAIL"} ${(graded.wallMs / 1000).toFixed(1)} s, ${graded.calls} calls${timedOut ? ", timed out" : ""}, answer ${JSON.stringify(graded.answer.slice(0, 80))}`,
        );
      }
    }
  }
}

let runs: ({ task: string; browser: string; run: number } & ReturnType<
  typeof grade
>)[] = [];

for (let file of (await readdir(out))
  .filter((name) => name.endsWith(".jsonl"))
  .sort()) {
  let [task, browser, run] = file.replace(/\.jsonl$/, "").split("-");
  if (!tasks[task]) continue;
  runs.push({
    task,
    browser,
    run: Number(run),
    ...grade(task, await loadEvents(join(out, file)), expected),
  });
}

let groups = Object.groupBy(runs, (run) => `${run.task} ${run.browser}`);

let summary = Object.values(groups).map((group) => {
  let median = (pick: (run: (typeof runs)[number]) => number | null) =>
    quantile(
      group!.flatMap((run) => pick(run) ?? []),
      0.5,
    );
  let { task, browser } = group![0];
  return {
    task,
    browser,
    runs: group!.length,
    passed: group!.filter((run) => run.ok).length,
    medianWallMs: median((run) => run.wallMs),
    p25WallMs: quantile(
      group!.map((run) => run.wallMs),
      0.25,
    ),
    p75WallMs: quantile(
      group!.map((run) => run.wallMs),
      0.75,
    ),
    medianToolMs: median((run) => run.toolMs),
    medianCalls: median((run) => run.calls),
    medianInputTokens: median((run) => run.inputTokens),
    toolErrors: group!.reduce((sum, run) => sum + run.toolErrors, 0),
    timeouts: group!.filter((run) => run.timedOut).length,
  };
});

await writeFile(join(out, "runs.json"), JSON.stringify(runs, null, 2) + "\n");
await writeFile(
  join(out, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.table(summary);
