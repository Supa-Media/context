import type { DemoContextTree } from "../../features/console/placeholderData/treeHelpers";
import { file, folder, listing, teamFile } from "../../features/console/placeholderData/treeHelpers";
import type { FolderListSource, ListNote } from "../../features/console/files/listBlock/model";

/**
 * The workspace every frame is drawn against: the real Supa projects and a
 * realistic inbox. Fake values only — no ids, no addresses.
 */

/** Frames are drawn at a fixed "now" so relative dates read the same every run. */
export const NOW = new Date("2026-09-26T15:30:00").getTime();
const H = 60 * 60 * 1000;
const D = 24 * H;

export const PROJECTS: ReadonlyArray<{
  slug: string;
  title: string;
  status: string;
  owner: string;
  ago: number;
}> = [
  { slug: "project-views", title: "Project views", status: "active", owner: "Seyi", ago: 0.5 * H },
  { slug: "custom-domains", title: "Custom domains", status: "active", owner: "Sayo", ago: 2 * H },
  { slug: "website-folder", title: "Website folder", status: "active", owner: "Seyi", ago: 1 * D },
  { slug: "client-intake-publishing-incident", title: "Client intake publishing incident", status: "fix-in-review", owner: "Seyi", ago: 2 * D },
  { slug: "deprecate-the-agent-fleet", title: "Deprecate the agent fleet", status: "blocked", owner: "Seyi", ago: 6 * D },
  { slug: "code-decomposition", title: "Code decomposition", status: "active", owner: "John", ago: 15 * D },
];

/** Sub-projects: a note with a status one level inside a project folder. */
export const SUBPROJECTS: ReadonlyArray<{ path: string; title: string; status: string; owner: string; ago: number }> = [
  { path: "1-projects/website-folder/members-only-pages.md", title: "Members-only pages", status: "active", owner: "Seyi", ago: 3 * D },
  { path: "1-projects/website-folder/list-block.md", title: "List block", status: "planned", owner: "Seyi", ago: 1 * D },
  { path: "1-projects/website-folder/public-renderer.md", title: "Public renderer", status: "done", owner: "Seyi", ago: 3 * D },
  { path: "1-projects/custom-domains/cloudflare-handoff.md", title: "Cloudflare handoff", status: "active", owner: "Sayo", ago: 2 * D },
];

export const INBOX = [
  "0-inbox/cloudflare-saas-hostname-notes.md",
  "0-inbox/meeting-2026-09-25-website-review.md",
  "0-inbox/intake-incident-timeline.md",
  "0-inbox/sayo-dns-questions.md",
  "0-inbox/fleet-shutdown-checklist.md",
  "0-inbox/voice-memo-2026-09-24.md",
  "0-inbox/fwd-bandshell-permit.md",
];

export function WORKSPACE(base: DemoContextTree): DemoContextTree {
  const projectEntries = PROJECTS.map((p) => folder(`1-projects/${p.slug}`, "team"));
  const listings: DemoContextTree["listings"] = {
    ...base.listings,
    "0-inbox": listing("0-inbox", "private", [
      ...INBOX.map((path) => file(path)),
      folder("0-inbox/email", "private"),
    ]),
    "1-projects": listing("1-projects", "team", [...projectEntries, teamFile("1-projects/README.md")]),
  };
  for (const p of PROJECTS) {
    listings[`1-projects/${p.slug}`] = listing(`1-projects/${p.slug}`, "team", [
      teamFile(`1-projects/${p.slug}/overview.md`),
    ]);
  }
  return {
    ...base,
    listings,
    notes: {
      ...base.notes,
      "0-inbox/intake-incident-timeline.md": [
        "# Intake incident timeline",
        "",
        "Rough notes from Wednesday, before they go anywhere tidy.",
        "",
        "- 09:40 client intake page stops publishing new submissions",
        "- 10:15 traced to the publish step skipping forms with a share link",
        "- 11:30 fix up for review (Supa-Media/context#908)",
        "- Friday: #908 merged, publishing back to normal",
        "",
        "Follow-up: add a test that publishes a form with a live link.",
        "",
      ].join("\n"),
      "1-projects/README.md": [
        "# Projects",
        "",
        "Everything Supa Media is building.",
        "",
        "```list",
        "from: 1-projects",
        "rows: projects",
        "group: status",
        "show: owner, updated",
        "```",
        "",
      ].join("\n"),
    },
    defaultSelection: "1-projects/README.md",
    defaultExpanded: ["0-inbox", "1-projects"],
  };
}

const LIST_NOTES: ListNote[] = [
  ...PROJECTS.map((p) => ({
    path: `1-projects/${p.slug}/overview.md`,
    updatedAt: NOW - p.ago,
    heading: p.title,
    properties: { status: p.status, owner: p.owner, title: p.title },
  })),
  ...SUBPROJECTS.map((p) => ({
    path: p.path,
    updatedAt: NOW - p.ago,
    heading: p.title,
    properties: { status: p.status, owner: p.owner, title: p.title },
  })),
];

export const LIST_SOURCE: FolderListSource = {
  load: async () => ({ notes: LIST_NOTES, complete: true }),
  setProperty: async () => null,
};
