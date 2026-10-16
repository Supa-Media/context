import { useMemo, useState } from "react";
import { AdminChrome } from "../admin/AdminPane";
import { AiTab } from "../admin/AiSection";
import { ConsoleHeader } from "../admin/ConsoleHeader";
import { buildCatalog, type FolderNote } from "../admin/aiCatalog";
import { aiSub, parseAiPlace, type AiPlace } from "../admin/aiPlace";
import { AiNoteIoContext, type AiNoteIo } from "../admin/useAiNote";

/**
 * The staff console's AI tab on an in-memory `ai/` folder, for reviewing the
 * design in a browser: `?screen=ai&at=<place>`, where place is the tab's own
 * address (`jobs/texting-assistant/setups`, `skills/build-a-website`, …).
 * Reads and saves go to the map below, never to a bucket.
 *
 * The text is long on purpose: real setups carry a paragraph of `why:` and
 * `promoted_by:`, skills a long opening line, and every screen has to hold
 * those inside its columns.
 */
const props = (properties: Record<string, unknown>, heading: string, lede = "") => JSON.stringify({ properties, heading, lede });
const HOUR = 3_600_000;
const now = Date.now();
const ago = (hours: number) => now - hours * HOUR;

const LONG_WHY =
  "The core set still failed on lists folded into sentences and a show time left out, so this adds one rule for each, a sixth check before replying, and two more examples of short replies. Nothing is written for one question.";
const PROMOTED_BY =
  "Fixture Person, 2026-10-11 (website skills: Fixture Person, 2026-10-13; core tools, short history and the tone section: Fixture Person, 2026-10-14; effort high under the standing push-to-production rule)";

const setup = (name: string, hours: number, size: number, front: Record<string, unknown>) => ({
  path: `ai/setups/texting-assistant/${name}.md`,
  updatedAt: ago(hours),
  size,
  props: props({ job: "texting-assistant", ...front }, name),
});

const NOTES: FolderNote[] = [
  {
    path: "ai/production/texting-assistant.md",
    updatedAt: ago(30),
    size: 23_900,
    props: props(
      {
        job: "texting-assistant",
        models: { main: "anthropic/claude-haiku-5-5", think: "anthropic/claude-opus-5-5" },
        came_from: `setups/texting-assistant/skills-haiku (the guide prompt with task skills), plus open_web, plus the router, plus setups/texting-assistant/live-4-high-effort's effort, plus setups/texting-assistant/live-5-2026-10-14's body. ${LONG_WHY}`,
        why: LONG_WHY,
        promoted_by: PROMOTED_BY,
      },
      "Tex",
    ),
  },
  { path: "ai/production/search.md", updatedAt: ago(200), size: 1_400, props: props({ job: "search", from: "everywhere-wide", live_since: "2026-10-08", promoted_by: "Fixture Person" }, "Search") },
  { path: "ai/production/app-assistant.md", updatedAt: ago(400), size: 8_000, props: props({ job: "app-assistant", models: { main: "anthropic/claude-haiku-5-5" } }, "App assistant") },
  setup("live-5-2026-10-14", 30, 23_762, { came_from: "live-4-high-effort-2026-10-14 of the core set, revised after gh-29", why: LONG_WHY, made_by: "Claude" }),
  setup("live-4-high-effort-2026-10-14", 40, 22_286, { came_from: "live-3-2026-10-14", change: "Think at high effort instead of medium", made_by: "Claude" }),
  setup("live-3-2026-10-14", 50, 22_200, { based_on: "live-2-2026-10-14", why: "Three more examples of replies that sound like a person: a repeating routine, a list, and are you a bot." }),
  setup("caveman-2026-10-14", 6, 24_782, { based_on: "live-5-2026-10-14", change: "Every reply in the fewest words that still answer, articles dropped", made_by: "improver", status: "draft" }),
  setup("short-history-2026-10-15", 3, 21_000, { based_on: "live-5-2026-10-14", change: "Show the last two texts instead of four", made_by: "improver" }),
  setup("guide-haiku", 300, 12_169, { came_from: "guide-haiku of round five (2026-10-10), revised after its scores", why: "Round six tests routing more than words. The router is told that a question whose answer needs two facts put together is a think question." }),
  { path: "ai/setups/retired/texting-assistant/gpt-5-mini.md", updatedAt: ago(500), size: 3_780, props: props({ job: "texting-assistant", change: "A smaller model from another lab, on the same prompt" }, "gpt-5-mini") },
  { path: "ai/setups/search/everywhere-wide.md", updatedAt: ago(220), size: 789, props: props({ job: "search", change: "Search every workspace at once, twenty results" }, "everywhere-wide") },
  { path: "ai/setups/search/everywhere-tight.md", updatedAt: ago(210), size: 577, props: props({ job: "search", change: "Every workspace, eight results, a higher cut-off" }, "everywhere-tight") },
  {
    path: "ai/production/skills/build-a-website.md",
    updatedAt: ago(70),
    size: 2_933,
    props: props({ reach: ["tex"] }, "Make, change or publish their website", "You set the site up and send them a link to write the pages themselves; never fill a page with words they didn't give you, and check it before publishing."),
  },
  { path: "ai/production/skills/website-domain.md", updatedAt: ago(70), size: 3_644, props: props({}, "Put their website on its own domain", "Buy a domain only with their yes to the exact name and price, then set its DNS records and wait for the certificate before saying it works.") },
  { path: "ai/production/skills/connect-claude.md", updatedAt: ago(90), size: 1_576, props: props({ reach: ["tex", "mcp"] }, "Connect Claude to Context", "Do it yourself in your browser.") },
  { path: "ai/production/skills/connect-chatgpt.md", updatedAt: ago(90), size: 1_783, props: props({ reach: ["tex", "mcp", "helpers"] }, "Connect ChatGPT to Context", "Open ChatGPT's connector settings in the browser, add Context's address, and hand over only the sign-in.") },
  { path: "ai/production/skills/save-a-login.md", updatedAt: ago(120), size: 695, props: props({}, "Save a login or a key for them") },
  { path: "ai/production/skills/sign-in-for-them.md", updatedAt: ago(120), size: 1_112, props: props({}, "Sign in to a site for them", "Open the sign-in page, type their email, then hand the browser over for the code.") },
  { path: "ai/production/skills/shop-or-book.md", updatedAt: ago(120), size: 872, props: props({}, "Find or book a flight, a table or a product") },
  { path: "ai/tests/core.md", updatedAt: ago(26), size: 9_000, props: props({ job: "texting-assistant", covers: ["build-a-website", "connect-claude"] }, "Core", "The basics Tex must get right before anything ships: lookups, to-dos, corrections, reminders and the way it talks.") },
  { path: "ai/tests/search.md", updatedAt: ago(200), size: 3_000, props: props({ job: "search" }, "Search", "Questions whose answers sit in a shared workspace.") },
  { path: "ai/results/2026-10-14 core gh-31 scores.md", updatedAt: ago(28), size: 4_000, props: props({}, "texting-assistant, 2026-10-14: scores") },
  { path: "ai/results/2026-10-14 core gh-29 scores.md", updatedAt: ago(38), size: 4_000, props: props({}, "texting-assistant, 2026-10-14: scores") },
  { path: "ai/results/2026-10-15 core gh-33 scores.md", updatedAt: ago(2), size: 4_000, props: props({}, "texting-assistant, 2026-10-15: scores") },
  { path: "ai/results/2026-10-08 search gh-12 scores.md", updatedAt: ago(205), size: 2_000, props: props({}, "search, 2026-10-08: scores") },
  { path: "ai/agents/mail-checker.md", updatedAt: ago(10), size: 1_000, props: props({ callers: ["texting-assistant", "connected-ais"] }, "Mail checker", "Checks a draft before one email goes out, and asks first.") },
  { path: "ai/about.md", updatedAt: ago(400), props: props({}, "AI", "Everything the AIs in Context run on.") },
];

const CASES = [
  "1. When's my dentist appointment?",
  "2. what do I need to do before lisbon",
  "3. remind me saturday at 10 to sort out the branding and the logo files for the new site",
  "4. actually the dentist is at 3:30",
  "5. are you a bot",
];

function scores(day: string, rows: readonly string[], grid: Record<string, readonly string[]>, misses = ""): string {
  const names = Object.keys(grid);
  return [
    `## Scored by claude-haiku-5-5, ${day}`,
    "",
    "| setup | score | gates | judge lines | price | speed | texts | errors | good enough |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    misses,
    "### Case by case",
    "",
    `| case | ${names.join(" | ")} |`,
    `| --- | ${names.map(() => "---").join(" | ")} |`,
    ...CASES.map((title, index) => `| ${title} | ${names.map((name) => grid[name]![index]).join(" | ")} |`),
    "",
  ].join("\n");
}

const TEXTS: Record<string, string> = {
  "ai/production/texting-assistant.md": `---\njob: texting-assistant\nskills:\n  build-a-website: they want a website made\n  connect-claude: they want Claude to use Context\n---\n\nYou are a fixture assistant. Answer by text.\n\n## How you talk\n\nShort and plain.\n`,
  "ai/setups/texting-assistant/live-5-2026-10-14.md": "---\njob: texting-assistant\n---\n\nYou are a fixture assistant. Answer by text.\n\n## How you talk\n\nShort and plain.\n",
  "ai/setups/texting-assistant/short-history-2026-10-15.md": "---\njob: texting-assistant\nhistory: 2\n---\n\nYou are a fixture assistant. Answer by text.\n\n## How you talk\n\nShort, plain, and only the last two texts.\n",
  "ai/tests/core.md": [
    "---",
    "job: texting-assistant",
    "---",
    "",
    "# Core",
    "",
    ...CASES.flatMap((title) => [`## ${title}`, "", "- kind: task", "- must: answer from the notes, with the date and time the note gives", "- must not: make up a date that isn't in the notes", ""]),
  ].join("\n"),
  "ai/results/2026-10-15 core gh-33 scores.md": scores(
    "2026-10-15",
    [
      "| live-5-2026-10-14 | 93.3% | failed (q3) | 210 of 225 | $0.0260 | 6.7 s | 1.2 | 0 | no |",
      "| short-history-2026-10-15 | 100% | passed | 219 of 225 | $0.0210 | 6.1 s | 1.1 | 0 | yes |",
    ],
    { "live-5-2026-10-14": ["3 of 3", "3 of 3", "1 of 3", "3 of 3", "3 of 3"], "short-history-2026-10-15": ["3 of 3", "3 of 3", "3 of 3", "3 of 3", "3 of 3"] },
    'Why gates failed, live-5-2026-10-14:\n- q3 must "answer from the notes, with the date and time the note gives": 2 of 3 runs\n',
  ),
  "ai/results/2026-10-14 core gh-31 scores.md": scores(
    "2026-10-14",
    [
      "| live-5-2026-10-14 | 100% | passed | 216 of 225 | $0.0260 | 6.7 s | 1.2 | 0 | yes |",
      "| live-4-high-effort-2026-10-14 | 73.3% | failed (q2, q3) | 198 of 225 | $0.0330 | 7.0 s | 1.4 | 0 | no |",
    ],
    { "live-5-2026-10-14": ["3 of 3", "3 of 3", "3 of 3", "3 of 3", "3 of 3"], "live-4-high-effort-2026-10-14": ["3 of 3", "1 of 3", "0 of 3", "3 of 3", "3 of 3"] },
  ),
  "ai/results/2026-10-14 core gh-29 scores.md": scores(
    "2026-10-14",
    [
      "| live-4-high-effort-2026-10-14 | 73.3% | failed (q2) | 200 of 225 | $0.0330 | 7.3 s | 1.4 | 0 | no |",
      "| live-3-2026-10-14 | 66.7% | failed (q2, q3) | 190 of 225 | $0.0310 | 5.6 s | 1.3 | 1 | no |",
    ],
    { "live-4-high-effort-2026-10-14": ["3 of 3", "1 of 3", "3 of 3", "3 of 3", "3 of 3"], "live-3-2026-10-14": ["3 of 3", "0 of 3", "1 of 3", "3 of 3", "3 of 3"] },
  ),
  "ai/results/2026-10-08 search gh-12 scores.md": [
    "## Scored by claude-haiku-5-5, 2026-10-08",
    "",
    "| setup | score | gates | judge lines | price | speed | texts | errors | good enough |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| everywhere-wide | 88% | passed | 44 of 50 | $0.0010 | 0.4 s | 1 | 0 | yes |",
    "| everywhere-tight | 80% | failed (q4) | 40 of 50 | $0.0008 | 0.3 s | 1 | 0 | no |",
    "",
  ].join("\n"),
};

export function AiLibraryFixture({ at }: { at?: string }) {
  const [place, setPlace] = useState<AiPlace>(() => parseAiPlace(at ?? null) ?? { view: "overview" });
  const texts = useMemo(() => ({ ...TEXTS }), []);
  const io = useMemo<AiNoteIo>(
    () => ({
      readNote: async ({ path }) => ({ text: texts[path] ?? `# ${path}\n`, etag: "v1", readOnly: false }),
      writeNote: async ({ path, text }) => {
        texts[path] = text;
        return { etag: "v2" };
      },
    }),
    [texts],
  );
  const catalog = useMemo(() => buildCatalog(NOTES), []);
  return (
    <AiNoteIoContext.Provider value={io}>
      <AdminChrome wide>
        <ConsoleHeader tab="ai" onTab={() => {}} days={30} onDays={() => {}} unsetCount={1} />
        <AiTab
          workspaceId={"fixture" as never}
          catalog={catalog}
          me="Fixture Person"
          place={place}
          onPlace={(sub) => setPlace(parseAiPlace(sub) ?? { view: "overview" })}
          reload={() => {}}
          days={30}
        />
      </AdminChrome>
    </AiNoteIoContext.Provider>
  );
}

/** For a screenshot script: the address of a place, as `at=` takes it. */
export const fixtureAt = (place: AiPlace) => aiSub(place) ?? "";
