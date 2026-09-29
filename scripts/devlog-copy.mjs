/**
 * The pure half of the devlog automation: every string the Monday draft, the
 * GitHub draft release and the Discord post contain, and every decision about
 * whether to write one. Network code lives in `devlog-draft.mjs` and
 * `devlog-sync.mjs` and stays thin so these rules can be tested offline.
 *
 * A week is read only through `packages/shared/src/devlog.ts` (loaded with
 * Node's type stripping; it has no imports), so the page, the app, the draft
 * and every copy agree about what a week says. Nothing here decides what is
 * worth saying: the draft is a starting point for the owner, and the copies
 * are made from the week the owner already published.
 */

import { createHash } from "node:crypto";

import {
  DEVLOG_EXPLORING_DISCLAIMER,
  DEVLOG_PAGE_PATH,
  DEVLOG_SECTIONS,
  latestDevlogWeek,
  parseDevlog,
} from "../packages/shared/src/devlog.ts";
import { DEFAULT_WEBSITE_ROOT } from "../packages/shared/src/websiteRoutes.ts";

export const DEVLOG_URL = "https://context.lc/devlog";
export const DEVLOG_HANDLE = "context-lc";
export const DISCORD_LIMIT = 2000;
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- the page

/**
 * The devlog page in a public site snapshot, or null. The snapshot lists
 * pages relative to the site root (`devlog.md`), while `DEVLOG_PAGE_PATH`
 * names the note (`website/devlog.md`); both spellings are accepted so a
 * change on either side does not silently lose the page.
 */
export function publishedDevlog(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.pages)) return null;
  const page = snapshot.pages.find(
    (candidate) =>
      candidate?.path === DEVLOG_PAGE_PATH || `${DEFAULT_WEBSITE_ROOT}/${candidate?.path}` === DEVLOG_PAGE_PATH,
  );
  if (!page || typeof page.markdown !== "string") return null;
  const weeks = parseDevlog(page.markdown);
  return {
    markdown: page.markdown,
    revision: typeof snapshot.revision === "string" ? snapshot.revision : null,
    weeks,
    latest: latestDevlogWeek(weeks),
  };
}

/** The request body for the public `siteSnapshot` action over Convex HTTP. */
export function siteSnapshotRequest(convexUrl) {
  if (!convexUrl) {
    throw new Error("DEVLOG_CONVEX_URL is not set: add it as a repository variable to read the published devlog.");
  }
  let base;
  try {
    base = new URL(convexUrl);
  } catch {
    throw new Error("DEVLOG_CONVEX_URL is not a URL.");
  }
  if (base.protocol !== "https:") throw new Error("DEVLOG_CONVEX_URL must be an https URL.");
  return {
    url: new URL("/api/action", base).href,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "functions/websites:siteSnapshot",
        args: { handle: DEVLOG_HANDLE },
        format: "json",
      }),
    },
  };
}

/** Read the published page. Throws on anything but a clean answer. */
export async function readPublishedDevlog(convexUrl, fetchImpl = fetch) {
  const { url, init } = siteSnapshotRequest(convexUrl);
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`The site snapshot read failed: HTTP ${response.status}.`);
  const data = await response.json();
  if (data?.status !== "success") throw new Error("The site snapshot read was refused.");
  const devlog = publishedDevlog(data.value);
  if (!devlog) throw new Error(`The published site has no ${DEVLOG_PAGE_PATH}.`);
  return devlog;
}

// ------------------------------------------------------------- one week

/** `september 28 to october 4, 2026`: the page's lowercase date line. */
export function formatDevlogDates(first, last) {
  const part = (date) => `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  if (first.getUTCFullYear() !== last.getUTCFullYear()) {
    return `${part(first)}, ${first.getUTCFullYear()} to ${part(last)}, ${last.getUTCFullYear()}`;
  }
  return `${part(first)} to ${part(last)}, ${last.getUTCFullYear()}`;
}

/**
 * The seven days a Monday run looks back over, and the calendar days they
 * name: a run on monday october 5 covers september 28 to october 4.
 */
export function draftWindow(now) {
  const end = new Date(now);
  const start = new Date(end.getTime() - 7 * DAY_MS);
  return { start, end, dates: formatDevlogDates(start, new Date(end.getTime() - DAY_MS)) };
}

/**
 * A week in the page's exact format. `number` may be the placeholder "N"
 * when the published page could not be read. This is also the canonical
 * text a copy's digest is taken over, so the same week always renders the
 * same bytes.
 */
export function renderWeekMarkdown({ number, dates, sections, legacy = [] }) {
  const lines = [`### week ${number}`];
  if (dates) lines.push(`*${dates}*`);
  for (const item of legacy) lines.push(`- ${item}`);
  for (const { key, heading } of DEVLOG_SECTIONS) {
    lines.push("", `#### ${heading}`);
    if (key === "exploring") lines.push(`*${DEVLOG_EXPLORING_DISCLAIMER}*`);
    for (const item of sections[key] ?? []) lines.push(`- ${item}`);
  }
  return `${lines.join("\n")}\n`;
}

/** sha256 of the week's canonical text: what a copy records as its source. */
export function weekDigest(week) {
  return createHash("sha256").update(renderWeekMarkdown(week)).digest("hex");
}

// ---------------------------------------------------------- Monday draft

/** A PR title in the owner's voice: first letter lowered unless an acronym. */
function lowerFirst(text) {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

/**
 * Shipped lines from the first-parent commits production moved: one per
 * pull request, its title, ending ` (#123)` so the owner can find it. A
 * commit with no pull request is returned separately, never guessed into
 * a line.
 */
export function shippedFromCommits(commits) {
  const seen = new Set();
  const shipped = [];
  const direct = [];
  for (const commit of commits) {
    if (commit.pullRequest === null) {
      direct.push(commit);
      continue;
    }
    if (seen.has(commit.pullRequest)) continue;
    seen.add(commit.pullRequest);
    shipped.push(lowerFirst(commit.subject));
  }
  return { shipped, direct };
}

/**
 * The draft week. Shipped comes from production; in progress, exploring and
 * declined are the latest published week's lines, verbatim, for the owner
 * to edit. Without a published page the number is "N" and those sections
 * are empty, and `note` says why.
 */
export function buildDraft({ published, readError = null, dates, commits }) {
  const { shipped, direct } = shippedFromCommits(commits);
  const latest = published?.latest ?? null;
  const carried = latest?.sections ?? { inProgress: [], exploring: [], declined: [] };
  const number = latest ? latest.number + 1 : "N";
  let note = null;
  if (readError) note = `The published devlog could not be read (${readError}), so the week number is N and nothing was carried.`;
  else if (!latest) note = "The published devlog has no week yet, so the week number is N and nothing was carried.";
  const markdown = renderWeekMarkdown({
    number,
    dates,
    sections: {
      shipped,
      inProgress: [...carried.inProgress],
      exploring: [...carried.exploring],
      declined: [...carried.declined],
    },
  });
  return { number, markdown, shipped, direct, carriedFrom: latest?.number ?? null, note };
}

/** The job summary: the week in a fence, and what the owner does next. */
export function renderDraftSummary({ draft, runs, interval }) {
  const lines = [`## Devlog draft · week ${draft.number}`, ""];
  lines.push("Draft only. Nothing was written to the devlog, no release was created, and nothing was posted.", "");
  if (runs.length === 0) {
    lines.push("No production promotion completed in these seven days, so nothing shipped this week.", "");
  } else {
    const links = runs.map((run) => `[${run.run_number}](${run.html_url})`).join(", ");
    lines.push(
      `Production runs ${links} moved ${interval.from.slice(0, 12)}..${interval.to.slice(0, 12)}.`,
      "Shipped lines are pull request titles: trim them to what people notice, and remove the (#123) numbers on the page.",
      "",
    );
  }
  if (draft.note) lines.push(draft.note, "");
  else lines.push(`In progress, exploring and declined are copied from week ${draft.carriedFrom} as published.`, "");
  lines.push("````markdown", draft.markdown.trimEnd(), "````", "");
  if (draft.direct.length > 0) {
    lines.push("Commits without a pull request, not listed above:", "");
    for (const commit of draft.direct) lines.push(`- ${commit.sha.slice(0, 12)} ${commit.subject}`);
    lines.push("");
  }
  return `${lines.join("\n")}`;
}

// ------------------------------------------------------ GitHub draft copy

/** "september 28 to october 4, 2026" → "September 28 to October 4, 2026". */
export function sentenceCaseDates(dates) {
  const months = dates.replace(new RegExp(`\\b(${MONTHS.join("|")})\\b`, "gi"), (month) =>
    month[0].toUpperCase() + month.slice(1).toLowerCase(),
  );
  return months[0].toUpperCase() + months.slice(1);
}

function sentenceCase(text) {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_, lead, letter) => lead + letter.toUpperCase());
}

export const releaseTag = (number) => `devlog-week-${number}`;
export const releaseName = (week) =>
  week.dates ? `Week ${week.number} · ${sentenceCaseDates(week.dates)}` : `Week ${week.number}`;

const MARKER = /<!-- devlog-sync week=(\d+) revision=(\S+) sha256=([a-f0-9]{64}) discord=(\d+|none) -->/;

export function syncMarker({ week, revision, digest, discordMessageId }) {
  const source = revision === null ? "none" : encodeURIComponent(revision);
  return `<!-- devlog-sync week=${week} revision=${source} sha256=${digest} discord=${discordMessageId ?? "none"} -->`;
}

export function parseSyncMarker(body) {
  const match = MARKER.exec(body ?? "");
  if (!match) return null;
  return {
    week: Number(match[1]),
    revision: match[2] === "none" ? null : decodeURIComponent(match[2]),
    digest: match[3],
    discordMessageId: match[4] === "none" ? null : match[4],
  };
}

/** The GitHub copy of a week: sentence-case headings, empty sections left out. */
export function renderReleaseBody(week, { revision, discordMessageId = null }) {
  const lines = [];
  if (week.legacy.length > 0) {
    for (const item of week.legacy) lines.push(`- ${item}`);
    lines.push("");
  }
  for (const { key, heading } of DEVLOG_SECTIONS) {
    const items = week.sections[key];
    if (items.length === 0) continue;
    lines.push(`### ${sentenceCase(heading)}`, "");
    if (key === "exploring") lines.push(`*${sentenceCase(DEVLOG_EXPLORING_DISCLAIMER)}*`, "");
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  }
  lines.push(`The full devlog is at ${DEVLOG_URL}.`, "");
  lines.push(syncMarker({ week: week.number, revision, digest: weekDigest(week), discordMessageId }));
  return `${lines.join("\n")}\n`;
}

/**
 * What the create or update call sends. `draft: true` is fixed here, not
 * passed in: publishing a release is the owner's act, by hand.
 */
export function releasePayload(week, { revision, discordMessageId = null }) {
  return {
    tag_name: releaseTag(week.number),
    name: releaseName(week),
    body: renderReleaseBody(week, { revision, discordMessageId }),
    draft: true,
    prerelease: false,
  };
}

/**
 * Whether this week's release is created, updated, left alone, or no longer
 * ours. A published release is the owner's, so it is never edited.
 */
export function decideRelease(releases, week) {
  const digest = weekDigest(week);
  const tag = releaseTag(week.number);
  const mine = releases
    .filter((release) => release.tag_name === tag || parseSyncMarker(release.body)?.week === week.number)
    .sort((a, b) => a.id - b.id);
  const published = mine.find((release) => release.draft !== true);
  if (published) return { action: "published", release: published, digest, marker: parseSyncMarker(published.body) };
  if (mine.length === 0) return { action: "create", release: null, digest, marker: null };
  const release = mine[0];
  const marker = parseSyncMarker(release.body);
  if (marker?.digest === digest) return { action: "none", release, digest, marker };
  return { action: "update", release, digest, marker };
}

// -------------------------------------------------------------- Discord

/**
 * Discord speaks only when the secret exists and the owner switched it on,
 * posts once per week, and edits that one message when the week changes.
 */
export function decideDiscord({ webhook, flag, releaseAction, messageId }) {
  if (releaseAction === "published") return "none";
  if (!webhook || flag !== "on") return "off";
  if (!messageId) return "post";
  return releaseAction === "update" ? "patch" : "none";
}

const DISCORD_EXPLORING = `(${DEVLOG_EXPLORING_DISCLAIMER})`;

function clip(text, cap) {
  const characters = Array.from(text);
  return characters.length <= cap ? text : `${characters.slice(0, cap - 1).join("")}…`;
}

function composeDiscord(week, lists, cap) {
  const lines = [`**devlog · week ${week.number}**${week.dates ? ` (${clip(week.dates, 80)})` : ""}`];
  const { shipped, more } = lists;
  if (shipped.length > 0 || more > 0) {
    lines.push("shipped");
    for (const item of shipped) lines.push(`• ${clip(item, cap)}`);
    if (more > 0) lines.push(`${more} more on the devlog`);
  }
  for (const [key, label] of [["inProgress", "in progress"], ["exploring", `exploring ${DISCORD_EXPLORING}`], ["declined", "declined"]]) {
    const items = lists[key];
    if (items.length === 0 && !lists.dropped[key]) continue;
    const tail = lists.dropped[key] ? ` · ${lists.dropped[key]} more` : "";
    lines.push(`• ${label}: ${items.map((item) => clip(item, cap)).join(" · ")}${tail}`);
  }
  lines.push(`full week: ${DEVLOG_URL}`);
  return lines.join("\n");
}

/**
 * The Discord message, always under the limit. Items are shortened, then
 * dropped (counted as "more"); the heading, the exploring disclaimer and
 * the link are never cut.
 */
export function renderDiscordMessage(week, limit = DISCORD_LIMIT) {
  const shippedAll = [...week.legacy, ...week.sections.shipped];
  const lists = {
    shipped: shippedAll.slice(0, 5),
    more: Math.max(0, shippedAll.length - 5),
    inProgress: [...week.sections.inProgress],
    exploring: [...week.sections.exploring],
    declined: [...week.sections.declined],
    dropped: { inProgress: 0, exploring: 0, declined: 0 },
  };
  let cap = 300;
  for (;;) {
    const text = composeDiscord(week, lists, cap);
    if (text.length < limit) return text;
    if (cap > 24) {
      cap = Math.floor(cap * 0.8);
      continue;
    }
    const longest = ["inProgress", "exploring", "declined", "shipped"]
      .filter((key) => lists[key].length > 0)
      .sort((a, b) => lists[b].length - lists[a].length)[0];
    if (!longest) return text.slice(0, limit - 1);
    lists[longest].pop();
    if (longest === "shipped") lists.more += 1;
    else lists.dropped[longest] += 1;
  }
}
