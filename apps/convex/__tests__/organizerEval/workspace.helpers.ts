/**
 * A MESSY WORKSPACE WITH KNOWN RIGHT ANSWERS, AND A SCORE FOR HOW ORGANIZED IT IS.
 *
 * The organization-score suite (`../organizerEval.test.ts`, and the live run
 * against the real model in `../organizerEval.live.test.ts`) starts from this
 * workspace, lets a sweep run with every "without asking" switch on, and reads
 * the bucket back. Every note here has one right end state, written next to it:
 *
 *  - an inbox note belongs in one folder (or stays, for a note that is about
 *    nothing in particular);
 *  - a project whose note says the work is finished should be marked done;
 *  - a finished project that has been quiet for weeks should be archived;
 *  - everything else should be left exactly where and how it is.
 *
 * The score is the share of those that hold. Starting messy, it is about a
 * quarter; a sweep that works should take it to 90% or better.
 *
 * Invented company, invented people. This repository is public.
 */

import { clearanceOf } from "../../functions/lib/clearance";
import type { FileStore } from "../../functions/lib/fileOps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import { noteProperties } from "../../../mcp/src/lists/properties.js";
import { defaultStatusList, isDoneStatus } from "../../../mcp/src/lists/statuses.js";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";

export const NOW = Date.UTC(2026, 9, 5, 12);
const DAY = 24 * 60 * 60 * 1000;
export const OWNER = clearanceOf("private");

/** Where a note should end up. `folder` is checked as the note's direct parent. */
export type Expected =
  | { kind: "file"; folder: string }
  | { kind: "stay" }
  | { kind: "done" }
  | { kind: "archive" }
  | { kind: "keep" };

export interface FixtureNote {
  path: string;
  text: string;
  /** How long ago it was last saved. */
  daysAgo: number;
  expected?: Expected;
}

function project(heading: string, status: string, body: string): string {
  return `---\nstatus: ${status}\n---\n# ${heading}\n\n${body.trim()}\n`;
}

function note(heading: string, body: string): string {
  return `# ${heading}\n\n${body.trim()}\n`;
}

export const NOTES: FixtureNote[] = [
  // ── Projects that are finished, though their status still says otherwise ──
  {
    path: "1-projects/website-redesign/overview.md",
    daysAgo: 20,
    expected: { kind: "done" },
    text: project("Website redesign", "in progress", `
The new site launched on September 12 and every page is live. Traffic is up 30%.

- [x] New homepage
- [x] Pricing page
- [x] Blog templates
- [x] Redirects from the old URLs
- [x] Launch announcement`),
  },
  {
    path: "1-projects/hiring-designer/overview.md",
    daysAgo: 10,
    expected: { kind: "done" },
    text: project("Hiring a product designer", "in progress", `
Maya Okafor accepted our offer and started on Monday. The role is filled and the job post is closed.
Nothing left to do here; onboarding lives in the team area.`),
  },
  {
    path: "1-projects/customer-portal/overview.md",
    daysAgo: 8,
    expected: { kind: "done" },
    text: project("Customer portal", "active", `
We merged the final pull request and the portal is live for every customer. No open items remain.

- [x] Login with email codes
- [x] Invoice history
- [x] Support tickets`),
  },

  // ── Projects still under way ──
  {
    path: "1-projects/q3-budget/overview.md",
    daysAgo: 2,
    expected: { kind: "keep" },
    text: project("Q3 budget", "in progress", `
Drafting the quarter's budget with the finance team.

- [x] Collect department requests
- [x] First draft
- [ ] Review with each lead
- [ ] Sign-off from finance
- [ ] Share with the board

Next: book the review meetings for next week.`),
  },
  {
    path: "1-projects/mobile-app-v2/overview.md",
    daysAgo: 0,
    expected: { kind: "keep" },
    text: project("Mobile app v2", "in progress", `
Rebuilding the app's home screen and adding push notifications. Beta is planned for November.

Open:
- [ ] Push notification permissions flow
- [ ] Offline mode
- [x] New navigation`),
  },
  {
    path: "1-projects/podcast-launch/overview.md",
    daysAgo: 5,
    expected: { kind: "keep" },
    text: project("Podcast launch", "blocked", `
Three episodes are recorded. We are waiting on the audio engineer to send back the mixes before we can publish anything.`),
  },
  {
    path: "1-projects/api-docs/overview.md",
    daysAgo: 1,
    expected: { kind: "keep" },
    text: project("API documentation", "in progress", `
Writing public docs for the API.

- [x] Authentication
- [x] Webhooks
- [ ] Rate limits
- [ ] Error codes

TODO: ask engineering for the current rate limit numbers.`),
  },
  {
    path: "1-projects/office-move/overview.md",
    daysAgo: 3,
    expected: { kind: "keep" },
    text: project("Office move", "finished", `
We moved into the new office on Friday. Still unpacking, but the project itself is over.`),
  },

  // ── Finished long ago and still sitting with live work ──
  {
    path: "1-projects/conference-2025/overview.md",
    daysAgo: 60,
    expected: { kind: "archive" },
    text: project("Conference 2025", "finished", "The conference happened in May. Recordings are posted."),
  },
  {
    path: "1-projects/newsletter-migration.md",
    daysAgo: 30,
    expected: { kind: "archive" },
    text: project("Newsletter migration", "done", "Moved all subscribers to the new email provider. Old account closed."),
  },

  // ── Folders an inbox note could belong in ──
  { path: "1-projects/website-redesign/launch-checklist.md", daysAgo: 20, text: note("Launch checklist", "Everything we checked before launch.") },
  { path: "1-projects/hiring-designer/candidates.md", daysAgo: 12, text: note("Candidates", "Shortlist and interview loop for the designer role.") },
  { path: "1-projects/q3-budget/department-requests.md", daysAgo: 4, text: note("Department requests", "What each team asked for in Q3.") },
  { path: "2-areas/finance/invoices.md", daysAgo: 15, text: note("Invoices", "How we send, track and chase invoices to clients.") },
  { path: "2-areas/finance/expenses.md", daysAgo: 15, text: note("Expenses", "Expense policy and receipts.") },
  { path: "2-areas/health/running-log.md", daysAgo: 6, text: note("Running log", "Weekly runs, distances and how they felt.") },
  { path: "2-areas/team/onboarding.md", daysAgo: 9, text: note("Onboarding", "How we welcome new people: accounts, first week, buddies.") },
  { path: "3-resources/recipes/weeknight-dinners.md", daysAgo: 40, text: note("Weeknight dinners", "Quick recipes for busy evenings.") },
  { path: "3-resources/reading-list/books.md", daysAgo: 25, text: note("Books", "Books to read and what I thought of them.") },

  // ── The mess: an inbox nobody has emptied ──
  {
    path: "0-inbox/interview-notes-maya.md",
    daysAgo: 14,
    expected: { kind: "file", folder: "1-projects/hiring-designer" },
    text: note("Interview notes: Maya", "Portfolio review for the product designer role. Strong systems thinking, great critique session. Recommend an offer."),
  },
  {
    path: "0-inbox/homepage-copy-draft.md",
    daysAgo: 22,
    expected: { kind: "file", folder: "1-projects/website-redesign" },
    text: note("Homepage copy draft", "Hero headline options and the subhead for the new website homepage."),
  },
  {
    path: "0-inbox/rate-limit-ideas.md",
    daysAgo: 1,
    expected: { kind: "file", folder: "1-projects/api-docs" },
    text: note("Rate limit ideas", "How to explain our API rate limits in the docs: per-key limits, the 429 response, and retry headers."),
  },
  {
    path: "0-inbox/acme-invoice-september.md",
    daysAgo: 3,
    expected: { kind: "file", folder: "2-areas/finance" },
    text: note("Acme invoice, September", "Invoice #1042 to Acme Corp for September consulting, $4,800, due in 30 days. Sent on the 1st."),
  },
  {
    path: "0-inbox/carbonara.md",
    daysAgo: 7,
    expected: { kind: "file", folder: "3-resources/recipes" },
    text: note("Carbonara", "Spaghetti, guanciale, egg yolks, pecorino, black pepper. Twenty minutes, no cream."),
  },
  {
    path: "0-inbox/5k-training-plan.md",
    daysAgo: 4,
    expected: { kind: "file", folder: "2-areas/health" },
    text: note("5k training plan", "Three runs a week for eight weeks: one easy, one tempo, one long. Race on December 6."),
  },
  {
    path: "0-inbox/episode-ideas.md",
    daysAgo: 6,
    expected: { kind: "file", folder: "1-projects/podcast-launch" },
    text: note("Episode ideas", "Topics for the next podcast episodes: founder stories, a listener Q&A, and a guest from a design studio."),
  },
  {
    path: "0-inbox/q3-forecast.md",
    daysAgo: 2,
    expected: { kind: "file", folder: "1-projects/q3-budget" },
    text: note("Q3 forecast", "Revenue and spend forecast for the third quarter, for the budget draft."),
  },
  {
    path: "0-inbox/first-week-checklist.md",
    daysAgo: 9,
    expected: { kind: "file", folder: "2-areas/team" },
    text: note("First week checklist", "What every new hire does in their first week: laptop, accounts, meet your buddy, read the handbook."),
  },
  {
    path: "0-inbox/books-from-sam.md",
    daysAgo: 11,
    expected: { kind: "file", folder: "3-resources/reading-list" },
    text: note("Books Sam recommended", "The Making of a Manager, Shape Up, and Working in Public."),
  },
  {
    path: "0-inbox/push-notification-spec.md",
    daysAgo: 0,
    expected: { kind: "file", folder: "1-projects/mobile-app-v2" },
    text: note("Push notification spec", "When the mobile app asks for notification permission, and which events send a push."),
  },
  {
    path: "0-inbox/portal-feedback-acme.md",
    daysAgo: 5,
    expected: { kind: "file", folder: "1-projects/customer-portal" },
    text: note("Portal feedback from Acme", "Acme's team likes the customer portal's invoice history but wants CSV export."),
  },
  {
    path: "0-inbox/meetings/2026-10-01-homepage-review.md",
    daysAgo: 4,
    expected: { kind: "file", folder: "1-projects/website-redesign" },
    text: note("Homepage review", "Meeting about the new website: the homepage hero, the pricing page layout and the blog templates."),
  },
  {
    path: "0-inbox/errands.md",
    daysAgo: 1,
    expected: { kind: "stay" },
    text: note("Errands", "Buy milk. Call the dentist back. Return the library book."),
  },
];

/** The fixture as a bucket, with each note's last save where the fixture says. */
export function messyWorkspace(): { store: MemoryStore & FileStore; savedAt: Map<string, number> } {
  const base = memoryStore() as MemoryStore & FileStore;
  base.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  base.seed("index.md", "# Northwind\n");
  base.seed("9-archive/README.md", "# Archive\n");
  const savedAt = new Map<string, number>();
  for (const fixture of NOTES) {
    base.seed(fixture.path, fixture.text);
    savedAt.set(fixture.path, NOW - fixture.daysAgo * DAY);
  }
  // The stub reports every object as saved at the epoch; this one reports the
  // fixture's dates, and "now" for anything written during the run.
  const list = base.list.bind(base);
  const put = base.put.bind(base);
  base.list = async (options) => {
    const page = await list(options);
    return { ...page, objects: page.objects.map((object) => ({ ...object, uploaded: new Date(savedAt.get(object.key) ?? NOW) })) };
  };
  base.put = async (key, body, options) => {
    const written = await put(key, body, options);
    if (written) savedAt.set(key, NOW);
    return written;
  };
  return { store: base, savedAt };
}

/** Where a fixture note is now: found by its file name, outside plumbing. */
function whereIs(keys: string[], original: string): string | null {
  const leaf = original.split("/").pop()!;
  const folderNote = /\/(overview|index|README)\.md$/.test(original);
  const wanted = folderNote ? `${original.split("/").slice(-2).join("/")}` : leaf;
  const hits = keys.filter((key) => !key.startsWith(".") && (key === original || key.endsWith(`/${wanted}`)));
  return hits.find((key) => key === original) ?? hits[0] ?? null;
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

export interface ItemScore {
  path: string;
  expected: Expected;
  now: string | null;
  ok: boolean;
}

/** The share of fixture notes in their right end state, 0..1, with each one's verdict. */
export function organizationScore(snapshot: Record<string, string>): { score: number; items: ItemScore[] } {
  // A real bucket store deletes by leaving a tombstone at the old key
  // (`store/logicalDelete.js`): a key holding one is not a note.
  const keys = Object.keys(snapshot).filter((key) => !String(snapshot[key]).startsWith("context.logical-delete."));
  const list = defaultStatusList();
  const items: ItemScore[] = [];
  for (const fixture of NOTES) {
    if (!fixture.expected) continue;
    const now = whereIs(keys, fixture.path);
    const text = now ? snapshot[now] ?? "" : "";
    const status = String(noteProperties(text).status ?? "").trim();
    let ok = false;
    switch (fixture.expected.kind) {
      case "file":
        ok = now !== null && parentOf(now) === fixture.expected.folder;
        break;
      case "stay":
        ok = now === fixture.path;
        break;
      case "done":
        ok = now === fixture.path && isDoneStatus(status, list);
        break;
      case "archive":
        ok = now !== null && now.startsWith("9-archive/");
        break;
      case "keep":
        ok = now === fixture.path && text === fixture.text;
        break;
    }
    items.push({ path: fixture.path, expected: fixture.expected, now, ok });
  }
  const score = items.filter((item) => item.ok).length / items.length;
  return { score, items };
}

/** One line per miss, for a failing assertion to print. */
export function misses(items: ItemScore[]): string {
  return items
    .filter((item) => !item.ok)
    .map((item) => `${item.path}: wanted ${JSON.stringify(item.expected)}, now at ${item.now ?? "(gone)"}`)
    .join("\n");
}
