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

type Expected = {
  hnUser: string;
  jqTag: string;
  ytSpotify: string;
  flightDate: string;
};
type Task = {
  prompt: (fixture: string, expected: Expected) => string;
  // pageText is the tool results' text from every saved run of the task, for answers no fixed value can grade.
  check: (answer: string, expected: Expected, pageText: string) => boolean;
  // The run may read the fixture's folder, which Claude in Chrome needs to upload it.
  readsFixture?: boolean;
};

let site = "http://127.0.0.1:8765/bench";
let video = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
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
  ytsearch: {
    prompt: () =>
      'Go to https://www.youtube.com, search for "never gonna give you up official", open the top result and report its channel and the year it was uploaded.',
    check: (answer) => /rick astley/i.test(answer) && answer.includes("2009"),
  },
  ytplayer: {
    prompt: () =>
      `Go to ${video}, pause the video, then use the player's controls to move it to 2:00 without reloading the page or changing its URL. Report the time the player then shows.`,
    check: (answer) =>
      [...answer.matchAll(/(\d+):(\d\d)/g)].some(
        ([, minutes, seconds]) =>
          Math.abs(Number(minutes) * 60 + Number(seconds) - 120) <= 5,
      ),
  },
  // No fixed value grades the first comment, so the handle only has to be one some run's tools read as text, since an agent reading a screenshot leaves none.
  ytcomments: {
    prompt: () =>
      `Go to ${video}, scroll down to the comments and report the handle (starting with @) of whoever wrote the first comment listed.`,
    check: (answer, _, pageText) => {
      let handle = answer.match(/@[\w.-]+/)?.[0];
      return (
        !!handle &&
        !/rickastley/i.test(handle) &&
        pageText.toLowerCase().includes(handle.toLowerCase())
      );
    },
  },
  ytdesc: {
    prompt: () =>
      `Go to ${video}, expand the video's description and report the link it gives for listening to Rick Astley on Spotify.`,
    check: (answer, expected) =>
      answer.toLowerCase().includes(expected.ytSpotify.toLowerCase()),
  },
  // Logged out, so the address is set again each run (it persists in each browser's cookies after the first); prices change, so any price passes.
  doordash: {
    prompt: () =>
      "Go to https://www.doordash.com, set the delivery address to 1 Market St, San Francisco, CA 94105, open the nearest Chipotle Mexican Grill and report the price of a Burrito (not the Burrito Bowl). Do not sign in or add anything to the cart.",
    check: (answer) => /\$\d+\.\d\d/.test(answer),
  },
  // Apple's option prices load only as options are picked, so the total is pinned from a run by hand; a changed price fails every run loudly.
  apple: {
    prompt: () =>
      "Go to https://www.apple.com/shop/buy-mac/macbook-pro and configure a 14-inch MacBook Pro in Space Black with the standard display, the M6 chip, 24GB of unified memory and 2TB of storage. Report the price the page shows for that configuration. Do not add it to the bag.",
    check: (answer) => /\$2,?699/.test(answer),
  },
  // An archived post, so its comments and their order no longer change.
  reddit: {
    prompt: () =>
      "Go to https://www.reddit.com/r/space/comments/frdd1d/?sort=top and report the username of whoever wrote the first top-level comment.",
    check: (answer) => /lewri/i.test(answer),
  },
  maps: {
    prompt: () =>
      "Go to https://www.openstreetmap.org, search for the Ferry Building in San Francisco and report its street address with its postcode.",
    check: (answer) =>
      /\b1,? the embarcadero/i.test(answer) && answer.includes("94111"),
  },
  // Fares change between runs, so the price only has to be one some run's tools read as text, like ytcomments.
  flights: {
    prompt: (_, expected) =>
      `Go to https://www.kayak.com/flights and use its search form to find one-way economy flights for 1 adult from SFO to JFK (not nearby airports) on ${new Date(`${expected.flightDate}T12:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}. Report the cheapest price shown. Do not sign in or book anything.`,
    check: (answer, _, pageText) => {
      let price = answer.match(/\$[\d,]+/)?.[0];
      return !!price && pageText.includes(price);
    },
  },
  // The example's code comments give its default outputs, so only the edited line grades; working it out without running cannot be told apart.
  mdn: {
    prompt: () =>
      "Go to https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/at. In the page's interactive example, change the code so the first `index` is 4, run it with the example's Run button and report the first line of output it prints.",
    check: (answer) => /an index of 4 returns 44/i.test(answer),
  },
  // A 2023 thread whose likes have settled; it opens with Bluesky's own continuation posts, which the prompt skips.
  bluesky: {
    prompt: () =>
      "Go to https://bsky.app/profile/bsky.app/post/3jymkky4cxf2u and report the handle (starting with @) of the first account other than Bluesky (@bsky.app) that replied to the post. Do not sign in.",
    check: (answer) => /oedipusnj/i.test(answer),
  },
  // Pinned from a run by hand, like apple; a changed recipe fails every run loudly.
  allrecipes: {
    prompt: () =>
      "Go to https://www.allrecipes.com, use the site's search to find the recipe World's Best Lasagna and report its prep time and how many servings it makes. Do not sign in or save anything.",
    check: (answer) => /30\s*min/i.test(answer) && /\b12\b/.test(answer),
  },
  // Safari shows the PDF in its own viewer, which page reads cannot see into; pinned like apple.
  irs: {
    prompt: () =>
      'Open https://www.irs.gov/pub/irs-pdf/fw9.pdf in the browser and report the revision date printed on Form W-9 (the "Rev." date under the form number). Read it from the page; do not download the file.',
    check: (answer) => /march,?\s+2024/i.test(answer),
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
  let watch = await (
    await fetch(video, { headers: { "accept-language": "en-US" } })
  ).text();
  let description = JSON.parse(
    `"${watch.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/)?.[1] ?? ""}"`,
  );
  let expected = {
    hnUser: (await item(story.kids[0])).by,
    jqTag: release.tag_name,
    // Without the scheme, since an agent may report the link as the page shows it.
    ytSpotify:
      description.match(/Spotify:\s*(\S+)/)?.[1]?.replace(/^https?:\/\//, "") ??
      "",
    // About three weeks out, fixed per pass so every run searches the same day.
    flightDate: new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10),
  };
  if (!expected.hnUser || !expected.jqTag || !expected.ytSpotify)
    throw new Error(
      `could not fetch the public answers: ${JSON.stringify(expected)}`,
    );

  await writeFile(path, JSON.stringify(expected, null, 2) + "\n");
  return expected;
};

let grade = (
  task: string,
  events: Timed[],
  expected: Expected,
  pageText: string,
) => {
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
    ok: !!answer && tasks[task].check(answer, expected, pageText),
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

let pageText = async (task: string) =>
  (
    await Promise.all(
      (await readdir(out))
        .filter(
          (name) => name.startsWith(`${task}-`) && name.endsWith(".jsonl"),
        )
        .map(async (name) =>
          toolCalls(await loadEvents(join(out, name)))
            .map((call) => call.text)
            .join("\n"),
        ),
    )
  ).join("\n");

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
          `${tasks[task].prompt(fixture, expected)}\n${ending}`,
          values.model,
          tasks[task].readsFixture ? { readDirs: [dirname(fixture)] } : {},
        );
        if (timedOut)
          events.push({
            ms: events.at(-1)?.ms ?? 0,
            event: { type: "timeout" },
          });

        await saveEvents(path, events);
        let graded = grade(task, events, expected, await pageText(task));
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
    ...grade(
      task,
      await loadEvents(join(out, file)),
      expected,
      await pageText(task),
    ),
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
