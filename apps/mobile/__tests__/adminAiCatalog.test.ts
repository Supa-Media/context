/**
 * The AI tab's catalog (`features/admin/aiCatalog.ts`): which `ai/` notes are
 * a job's setup, a skill, a test, a setup being tried, or a scored round, and
 * how a job's quality cell reads. Pure: the notes are fake rows shaped the
 * way `folderNotes` answers them.
 */

import { describe, expect, test } from "@jest/globals";
import {
  AI_JOBS,
  attention,
  buildCatalog,
  jobQuality,
  matches,
  modelName,
  provedBy,
  reachOf,
  readScores,
  setupModels,
  type FolderNote,
  type JobRow,
} from "../features/admin/aiCatalog";

/** The shape the AI Benchmark Action writes (`apps/mcp/bench/score.mjs`). */
const SCORES = [
  "# texting-assistant, 2026-10-14: scores",
  "",
  "## Scored by claude-haiku-5-5, 2026-10-14",
  "",
  "| setup | score | gates | judge lines | price | speed | texts | errors | good enough |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  "| live-5 | 93.3% | failed (q5) | 203 of 225 (90.2%) | $0.0177 | 6.6 s | 1.2 | 0 | no |",
  "",
  "Why gates failed, live-5:",
  '- q5 must not "invent a to-do that isn\'t in the notes": 1 of 3 runs',
  "",
  "## Summary",
  "",
  "| Setup | Model |",
].join("\n");

function note(path: string, properties: Record<string, unknown> = {}, extra: { heading?: string; lede?: string; updatedAt?: number } = {}): FolderNote {
  return {
    path,
    updatedAt: extra.updatedAt,
    props: JSON.stringify({ properties, heading: extra.heading ?? "", lede: extra.lede ?? "" }),
  };
}

const job = (catalog: ReturnType<typeof buildCatalog>, key: string): JobRow => {
  const row = catalog.jobs.find((entry) => entry.job.key === key);
  if (!row) throw new Error(`no job ${key}`);
  return row;
};

describe("live setups and jobs", () => {
  test("ai/production/texting-assistant.md is the texting-assistant job's setup", () => {
    const catalog = buildCatalog([note("ai/production/texting-assistant.md", { title: "Tex live" })]);
    const tex = job(catalog, "texting-assistant");
    expect(tex.setup?.path).toBe("ai/production/texting-assistant.md");
    expect(tex.setup?.name).toBe("texting-assistant");
    expect(tex.setup?.title).toBe("Tex live");
  });

  test("a live setup for a job nobody declared lands under other, never lost", () => {
    const catalog = buildCatalog([note("ai/production/mystery-job.md")]);
    expect(catalog.other.map((row) => row.path)).toContain("ai/production/mystery-job.md");
    expect(catalog.jobs.every((row) => row.setup === null)).toBe(true);
  });

  test("ai/production/skills/x.md is a skill, not a setup", () => {
    const catalog = buildCatalog([note("ai/production/skills/x.md", { title: "Write a reply" }, { heading: "Heading" })]);
    expect(catalog.skills.map((row) => row.path)).toEqual(["ai/production/skills/x.md"]);
    expect(catalog.skills[0]!.title).toBe("Write a reply");
    expect(catalog.jobs.every((row) => row.setup === null)).toBe(true);
    expect(catalog.other).toEqual([]);
  });

  test("a skill's title falls back to its first heading, then its file name", () => {
    const catalog = buildCatalog([
      note("ai/production/skills/with-heading.md", {}, { heading: "From the heading" }),
      note("ai/production/skills/bare.md"),
    ]);
    expect(catalog.skills.find((row) => row.name === "bare")!.title).toBe("bare");
    expect(catalog.skills.find((row) => row.name === "with-heading")!.title).toBe("From the heading");
  });

  test("skills sort by title", () => {
    const catalog = buildCatalog([
      note("ai/production/skills/b.md", { title: "Zebra" }),
      note("ai/production/skills/a.md", { title: "Apple" }),
    ]);
    expect(catalog.skills.map((row) => row.title)).toEqual(["Apple", "Zebra"]);
  });
});

describe("setups being tried", () => {
  test("ai/setups/texting-assistant/live.md is a setup and counts in setupsTried", () => {
    const catalog = buildCatalog([note("ai/setups/texting-assistant/live.md")]);
    expect(catalog.setups.map((row) => row.path)).toEqual(["ai/setups/texting-assistant/live.md"]);
    expect(job(catalog, "texting-assistant").setupsTried).toBe(1);
    expect(job(catalog, "app-assistant").setupsTried).toBe(0);
  });

  test("ai/setups/texting-assistant/skills/x.md is not a setup", () => {
    const catalog = buildCatalog([note("ai/setups/texting-assistant/skills/x.md")]);
    expect(catalog.setups).toEqual([]);
    expect(job(catalog, "texting-assistant").setupsTried).toBe(0);
  });

  test("ai/setups/retired/... is not a setup", () => {
    const catalog = buildCatalog([note("ai/setups/retired/old.md"), note("ai/setups/retired/texting-assistant/old.md")]);
    expect(catalog.setups).toEqual([]);
    expect(catalog.other).toEqual([]);
    expect(job(catalog, "texting-assistant").setupsTried).toBe(0);
  });
});

describe("tests", () => {
  test("ai/tests/core.md with job texting-assistant attaches to that job", () => {
    const catalog = buildCatalog([note("ai/tests/core.md", { job: "texting-assistant" })]);
    expect(job(catalog, "texting-assistant").tests.map((row) => row.name)).toEqual(["core"]);
    expect(job(catalog, "search").tests).toEqual([]);
    expect(catalog.tests.map((row) => row.name)).toEqual(["core"]);
  });

  test("a test with no job property attaches to the job of its own name", () => {
    const catalog = buildCatalog([note("ai/tests/search.md")]);
    expect(job(catalog, "search").tests.map((row) => row.name)).toEqual(["search"]);
  });

  test("a test with a job property does not attach to a job of its own name", () => {
    const catalog = buildCatalog([note("ai/tests/search.md", { job: "texting-assistant" })]);
    expect(job(catalog, "search").tests).toEqual([]);
    expect(job(catalog, "texting-assistant").tests.map((row) => row.name)).toEqual(["search"]);
  });
});

describe("results", () => {
  test("ai/results/'2026-10-14 core gh-33 scores.md' is a result for test core on that day", () => {
    const catalog = buildCatalog([note("ai/results/2026-10-14 core gh-33 scores.md", { score: "81", gates: "pass", good_enough: "yes", setup: "live" })]);
    expect(catalog.results).toHaveLength(1);
    const result = catalog.results[0]!;
    expect(result.test).toBe("core");
    expect(result.day).toBe("2026-10-14");
    expect(result.score).toBe("81");
    expect(result.gates).toBe("pass");
    expect(result.goodEnough).toBe("yes");
    expect(result.setup).toBe("live");
  });

  test("a round with the test on its name and a job tests it through the job's name", () => {
    const catalog = buildCatalog([
      note("ai/tests/core.md", { job: "texting-assistant" }),
      note("ai/results/2026-10-14 core gh-33 scores.md", { score: "81", good_enough: "yes" }),
    ]);
    expect(job(catalog, "texting-assistant").latest?.test).toBe("core");
  });

  test("the newest round is the job's latest, by day first", () => {
    const catalog = buildCatalog([
      note("ai/tests/core.md", { job: "texting-assistant" }),
      note("ai/results/2026-10-10 core gh-20 scores.md", { score: "60" }, { updatedAt: 9_000 }),
      note("ai/results/2026-10-14 core gh-33 scores.md", { score: "81" }, { updatedAt: 1_000 }),
    ]);
    expect(catalog.results.map((row) => row.day)).toEqual(["2026-10-14", "2026-10-10"]);
    expect(job(catalog, "texting-assistant").latest?.score).toBe("81");
  });

  test("on the same day the note updated last is the latest", () => {
    const catalog = buildCatalog([
      note("ai/tests/core.md", { job: "texting-assistant" }),
      note("ai/results/2026-10-14 core gh-33 scores.md", { score: "70" }, { updatedAt: 1_000 }),
      note("ai/results/2026-10-14 core gh-34 scores.md", { score: "90" }, { updatedAt: 5_000 }),
    ]);
    expect(job(catalog, "texting-assistant").latest?.score).toBe("90");
  });

  test("a result whose name does not end in scores is not a result", () => {
    const catalog = buildCatalog([note("ai/results/2026-10-14 core notes.md", { score: "1" })]);
    expect(catalog.results).toEqual([]);
  });
});

describe("notes nothing else claims", () => {
  test("about.md and README.md go to other", () => {
    const catalog = buildCatalog([note("ai/about.md"), note("ai/README.md"), note("ai/tests/README.md")]);
    expect(catalog.other.map((row) => row.path).sort()).toEqual(["ai/README.md", "ai/about.md", "ai/tests/README.md"].sort());
    expect(catalog.tests).toEqual([]);
  });

  test("only notes under ai/ are read at all", () => {
    const catalog = buildCatalog([note("1-projects/x.md"), note("ai/production/texting-assistant.md")]);
    expect(catalog.other).toEqual([]);
    expect(job(catalog, "texting-assistant").setup).not.toBeNull();
  });

  test("non-markdown files are ignored", () => {
    const catalog = buildCatalog([note("ai/production/skills/x.json")]);
    expect(catalog.skills).toEqual([]);
    expect(catalog.other).toEqual([]);
  });
});

describe("jobQuality", () => {
  test("no tests is No test yet", () => {
    const catalog = buildCatalog([note("ai/production/texting-assistant.md")]);
    expect(jobQuality(job(catalog, "texting-assistant"))).toEqual({ label: "No test yet", tone: "none" });
  });

  test("tests with no round is Not run yet", () => {
    const catalog = buildCatalog([note("ai/tests/core.md", { job: "texting-assistant" })]);
    expect(jobQuality(job(catalog, "texting-assistant"))).toEqual({ label: "Not run yet", tone: "none" });
  });

  test("a passing latest round is ok with its gates", () => {
    const catalog = buildCatalog([
      note("ai/tests/core.md", { job: "texting-assistant" }),
      note("ai/results/2026-10-14 core gh-33 scores.md", { score: "81", gates: "pass", good_enough: "yes" }),
    ]);
    expect(jobQuality(job(catalog, "texting-assistant"))).toEqual({ label: "81 · gates pass", tone: "ok" });
  });

  test("good_enough true (as text) is also ok", () => {
    const catalog = buildCatalog([
      note("ai/tests/core.md", { job: "texting-assistant" }),
      note("ai/results/2026-10-14 core gh-33 scores.md", { score: 81, good_enough: true }),
    ]);
    expect(jobQuality(job(catalog, "texting-assistant"))).toEqual({ label: "81", tone: "ok" });
  });

  test("a round not good enough is warn", () => {
    const catalog = buildCatalog([
      note("ai/tests/core.md", { job: "texting-assistant" }),
      note("ai/results/2026-10-14 core gh-33 scores.md", { score: "40", gates: "fail", good_enough: "no" }),
    ]);
    expect(jobQuality(job(catalog, "texting-assistant"))).toEqual({ label: "40 · gates fail", tone: "warn" });
  });

  test("a round without a score in front matter takes it from the note's text, once read", () => {
    const catalog = buildCatalog([
      note("ai/tests/core.md", { job: "texting-assistant" }),
      note("ai/results/2026-10-14 core gh-33 scores.md", {}),
    ]);
    expect(jobQuality(job(catalog, "texting-assistant"))).toEqual({ label: "Ran 2026-10-14", tone: "none" });
    const read = readScores(SCORES)!;
    expect(jobQuality(job(catalog, "texting-assistant"), read)).toEqual({ label: "93.3% · gates failed (q5)", tone: "warn" });
  });

  test("every declared job has a row", () => {
    const catalog = buildCatalog([]);
    expect(catalog.jobs.map((row) => row.job.key)).toEqual(AI_JOBS.map((entry) => entry.key));
  });
});

describe("matches", () => {
  const catalog = buildCatalog([
    note("ai/production/skills/reply.md", { title: "Write a reply" }, { lede: "Short, warm answers" }),
  ]);
  const row = catalog.skills[0]!;

  test("every word must appear in the name, title or lede", () => {
    expect(matches(row, "write reply")).toBe(true);
    expect(matches(row, "warm reply")).toBe(true);
    expect(matches(row, "write invoice")).toBe(false);
  });

  test("case does not matter and an empty query matches", () => {
    expect(matches(row, "WRITE")).toBe(true);
    expect(matches(row, "   ")).toBe(true);
  });
});

describe("malformed input", () => {
  test("malformed props JSON does not throw and reads as empty", () => {
    const bad: FolderNote = { path: "ai/production/skills/broken.md", props: "{not json" };
    let catalog: ReturnType<typeof buildCatalog> | undefined;
    expect(() => {
      catalog = buildCatalog([bad]);
    }).not.toThrow();
    expect(catalog!.skills[0]!.title).toBe("broken");
    expect(catalog!.skills[0]!.properties).toEqual({});
  });

  test("props that are not an object shape are tolerated", () => {
    const odd: FolderNote[] = [
      { path: "ai/production/skills/a.md", props: "null" },
      { path: "ai/production/skills/b.md", props: JSON.stringify({ properties: ["x"], heading: 3, lede: null }) },
      { path: "ai/production/skills/c.md", props: "" },
    ];
    expect(() => buildCatalog(odd)).not.toThrow();
    const catalog = buildCatalog(odd);
    expect(catalog.skills.map((row) => row.name)).toEqual(["a", "b", "c"]);
    expect(catalog.skills.every((row) => row.lede === "")).toBe(true);
  });

  test("a job property that is not text does not attach a test", () => {
    const catalog = buildCatalog([note("ai/tests/core.md", { job: { nested: true } })]);
    expect(job(catalog, "texting-assistant").tests).toEqual([]);
  });
});

describe("reading a scores note's text", () => {
  test("takes the first row when the live setup did not run, and its gate failures", () => {
    expect(readScores(SCORES)).toEqual({
      setup: "live-5",
      score: "93.3%",
      gates: "failed (q5)",
      goodEnough: false,
      misses: [{ question: 5, rule: 'must not "invent a to-do that isn\'t in the notes"', runs: "1 of 3 runs" }],
    });
  });

  test("prefers the production row, and reads yes as good enough", () => {
    const raw = SCORES.replace("| live-5 | 93.3%", "| production | 100% | passed | 1 | $0.01 | 1 s | 1 | 0 | yes |\n| live-5 | 93.3%");
    expect(readScores(raw)).toEqual(expect.objectContaining({ setup: "production", score: "100%", goodEnough: true, misses: [] }));
  });

  test("a note with no Scored by section reads as nothing", () => {
    expect(readScores("# Just a note\n")).toBeNull();
  });
});

describe("a setup's models, a skill's reach and its tests", () => {
  test("model ids read as names, a main and smart pair joined", () => {
    expect(modelName("anthropic/claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(modelName("@cf/zai-org/glm-4.7-flash")).toBe("glm-4.7-flash");
    const catalog = buildCatalog([note("ai/production/texting-assistant.md", { models: { main: "anthropic/claude-haiku-5-5", smart: "anthropic/claude-opus-5-5" } })]);
    expect(setupModels(job(catalog, "texting-assistant").setup)).toBe("Haiku 5.5 → Opus 5.5");
    expect(setupModels(null)).toBeNull();
  });

  test("a skill with no reach is Tex's alone; reach names who else", () => {
    const catalog = buildCatalog([
      note("ai/production/skills/a.md", {}),
      note("ai/production/skills/b.md", { reach: ["tex", "mcp"] }),
      note("ai/production/skills/c.md", { reach: "mcp" }),
    ]);
    expect(catalog.skills.map(reachOf)).toEqual([["tex"], ["tex", "mcp"], ["mcp"]]);
  });

  test("a test proves the skills its covers names", () => {
    const catalog = buildCatalog([
      note("ai/production/skills/send-email.md", {}),
      note("ai/production/skills/draft.md", {}),
      note("ai/tests/email.md", { job: "texting-assistant", covers: ["send-email"] }),
    ]);
    const [draft, send] = catalog.skills;
    expect(provedBy(send!, catalog.tests).map((test) => test.name)).toEqual(["email"]);
    expect(provedBy(draft!, catalog.tests)).toEqual([]);
  });
});

describe("what needs attention", () => {
  test("failing rounds, untested jobs, skills no test covers and missing setups", () => {
    const catalog = buildCatalog([
      note("ai/production/texting-assistant.md", {}),
      note("ai/production/skills/x.md", {}),
      note("ai/tests/core.md", { job: "texting-assistant" }),
      note("ai/results/2026-10-14 core gh-33 scores.md", {}),
    ]);
    const before = attention(catalog);
    expect(before.failing).toEqual([]);
    const path = job(catalog, "texting-assistant").latest!.path;
    const after = attention(catalog, new Map([[path, readScores(SCORES)!]]));
    expect(after.failing.map((row) => row.job.key)).toEqual(["texting-assistant"]);
    expect(after.untested.map((row) => row.job.key)).not.toContain("texting-assistant");
    expect(after.unproved.map((row) => row.name)).toEqual(["x"]);
    expect(after.noSetup.map((row) => row.job.key)).not.toContain("connected-ais");
    expect(after.noSetup.map((row) => row.job.key)).toContain("dream");
  });
});
