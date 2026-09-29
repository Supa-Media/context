/**
 * The weekly devlog: one website page, newest week on top, each week in four
 * sections — shipped, in progress, exploring, declined.
 *
 * _Decided by the owner, 2026-09-29_ (see
 * `docs/decisions/release-communication.md`). The canonical copy is the
 * pinned workspace's `website/devlog.md`; the app's What's new panel, the
 * weekly draft and any GitHub or Discord copy are all read from its published
 * text through this one parser, so the four surfaces cannot disagree about
 * what a week says.
 *
 * A page is a devlog because of its shape, not a setting: at least one
 * `### week N` heading. Weeks written before the four sections existed keep
 * their single list (`legacy`), unchanged.
 *
 * The one rule the parser enforces is that exploring is never a promise.
 * `devlogPromiseProblems` is what stops Publish when an exploring line names a
 * date or says "will", "soon", "coming" — see `websiteMetadata.ts`, where it
 * becomes a page problem and a problem holds the whole release.
 */

export type DevlogSectionKey = "shipped" | "inProgress" | "exploring" | "declined";

export const DEVLOG_SECTIONS: ReadonlyArray<{ key: DevlogSectionKey; heading: string }> = [
  { key: "shipped", heading: "shipped" },
  { key: "inProgress", heading: "in progress" },
  { key: "exploring", heading: "exploring" },
  { key: "declined", heading: "declined" },
];

/** The italic line every exploring section carries, as written on the page. */
export const DEVLOG_EXPLORING_DISCLAIMER = "ideas, not promises. some of these won't happen.";

/** The devlog's file name under a site root. */
export const DEVLOG_PAGE_FILE = "devlog.md";

/** The site path the pinned workspace publishes its devlog from. */
export const DEVLOG_PAGE_PATH = `website/${DEVLOG_PAGE_FILE}`;

/**
 * Whether an object key is the devlog page under this site root.
 *
 * The promise rule is the editorial rule of *this* page, not a rule about
 * Markdown that happens to be shaped like a week of it. Every workspace's
 * website compiles through the same code, so a rule left unscoped is our
 * house style holding a stranger's whole release: a customer page with a
 * `## Week 3` heading and an `#### Exploring` list would refuse to publish
 * because it named a month. Scope is the difference between a rule and an
 * imposition.
 */
export function isDevlogObjectKey(objectKey: string, root: string): boolean {
  const normalize = (text: string): string => text.normalize("NFC").toLowerCase();
  return normalize(objectKey) === `${normalize(root)}/${DEVLOG_PAGE_FILE}`;
}

export interface DevlogWeek {
  /** The N in `### week N`. */
  number: number;
  /** The italic line under the heading, without its asterisks, or null. */
  dates: string | null;
  sections: Record<DevlogSectionKey, string[]>;
  /** True when the week has at least one `####` section heading. */
  sectioned: boolean;
  /** Items written directly under the heading: the weeks before sections. */
  legacy: string[];
  /** Whether the exploring section carries its "ideas, not promises" line. */
  exploringDisclaimed: boolean;
}

const WEEK_HEADING = /^#{2,3}\s+week\s+(\d{1,4})\s*$/i;
const SECTION_HEADING = /^#{4}\s+(.+?)\s*$/;
const ITEM = /^\s*[-*+]\s+(.*\S)\s*$/;
const ITALIC = /^\s*[*_](.+)[*_]\s*$/;

function sectionKey(heading: string): DevlogSectionKey | null {
  const text = heading.trim().toLowerCase();
  return DEVLOG_SECTIONS.find((section) => section.heading === text)?.key ?? null;
}

function emptySections(): Record<DevlogSectionKey, string[]> {
  return { shipped: [], inProgress: [], exploring: [], declined: [] };
}

/**
 * Every week on the page, in page order (newest first as written). Anything
 * above the first week heading — the title, the navigation line — is not a
 * week and is ignored.
 */
export function parseDevlog(markdown: string): DevlogWeek[] {
  const weeks: DevlogWeek[] = [];
  let week: DevlogWeek | null = null;
  let section: DevlogSectionKey | null = null;
  let sawText = false;

  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = WEEK_HEADING.exec(line);
    if (heading) {
      week = {
        number: Number(heading[1]),
        dates: null,
        sections: emptySections(),
        sectioned: false,
        legacy: [],
        exploringDisclaimed: false,
      };
      weeks.push(week);
      section = null;
      sawText = false;
      continue;
    }
    if (week === null) continue;
    // Any other heading of week level or above ends the week.
    if (/^#{1,3}\s/.test(line)) {
      week = null;
      section = null;
      continue;
    }
    const sub = SECTION_HEADING.exec(line);
    if (sub) {
      section = sectionKey(sub[1]!);
      week.sectioned = true;
      sawText = true;
      continue;
    }
    if (line.trim() === "") continue;
    const item = ITEM.exec(line);
    if (item) {
      sawText = true;
      if (section !== null) week.sections[section].push(item[1]!);
      else if (!week.sectioned) week.legacy.push(item[1]!);
      continue;
    }
    const italic = ITALIC.exec(line);
    if (italic && section === "exploring" && /not promises/i.test(italic[1]!)) {
      week.exploringDisclaimed = true;
      continue;
    }
    if (italic && !sawText) {
      week.dates = italic[1]!.trim();
      sawText = true;
      continue;
    }
    sawText = true;
  }
  return weeks;
}

/** The newest week: the highest number, whatever order the page is in. */
export function latestDevlogWeek(weeks: readonly DevlogWeek[]): DevlogWeek | null {
  let latest: DevlogWeek | null = null;
  for (const week of weeks) if (latest === null || week.number > latest.number) latest = week;
  return latest;
}

/*
  Words that turn an idea into a commitment. "May" and "March" are left out of
  the months on purpose: they are ordinary words ("agents may suggest") far
  more often than dates in an exploring line.
*/
const PROMISE_PATTERNS: RegExp[] = [
  /\bwill\b/i,
  /\bwon't be long\b/i,
  /\bsoon\b/i,
  /\bcoming\b/i,
  /\bplanned\b/i,
  /\bplanning to\b/i,
  /\bscheduled\b/i,
  /\bshipping\b/i,
  /\blaunch(?:es|ing)?\b/i,
  /\bnext (?:week|month|quarter|year|release|sprint)\b/i,
  /\bthis (?:week|month|quarter|year)\b/i,
  /\b(?:by|in|before|after|until) (?:the )?(?:end of|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sep|sept|oct|nov|dec|q[1-4]|spring|summer|autumn|fall|winter)\b/i,
  /\b(?:january|february|april|june|july|august|september|october|november|december)\b/i,
  /\bq[1-4]\b/i,
  /\b20\d\d\b/,
  /\b\d{1,2}\/\d{1,2}\b/,
];

/** The words that made a line read as a promise, or null when it does not. */
export function promiseIn(line: string): string | null {
  for (const pattern of PROMISE_PATTERNS) {
    const match = pattern.exec(line);
    if (match) return match[0];
  }
  return null;
}

/**
 * Why this page may not be published, as owner-facing sentences. Empty for a
 * page that is not a devlog, and for every week written before sections.
 */
export function devlogPromiseProblems(markdown: string): string[] {
  const problems: string[] = [];
  for (const week of parseDevlog(markdown)) {
    const exploring = week.sections.exploring;
    if (exploring.length === 0) continue;
    if (!week.exploringDisclaimed) {
      problems.push(
        `Week ${week.number}: exploring needs its line "*${DEVLOG_EXPLORING_DISCLAIMER}*" under the heading.`,
      );
    }
    for (const item of exploring) {
      const words = promiseIn(item);
      if (words !== null) {
        problems.push(
          `Week ${week.number}: "${words}" in exploring reads like a promise. Reword it or move the line to in progress.`,
        );
      } else if (!/^looking at\b/i.test(item)) {
        problems.push(
          `Week ${week.number}: every exploring line starts with "looking at:". Fix: "${item.slice(0, 80)}"`,
        );
      }
    }
  }
  return problems;
}
