import { castPreviewFragment, type FolderIcons, type PreviewPage } from "../home/castPreview";

/**
 * The editor demo under page a's headline (Dev2, 2026-10-09: "a version of
 * the editor with the PARA structure, some folders open, emojis on the
 * folders, and text being written by different AIs and by humans on a
 * markdown page").
 *
 * It is not a picture of the editor. It is the homepage's own shell, the
 * console in visitor mode, playing this scene through the same cast player
 * an owner's "Preview demo" uses (`castPreview.ts`), so it changes whenever
 * the console does. The people, AIs and notes are made up, and the page
 * around it says so.
 */

export const SCENE_TITLE = "Launch plan";

const SCENE = `# Launch plan

The beta opens on **Oct 14**. Everything for the launch lives here, and every AI on the team reads it first.

## This week

- [x] Pick the launch date
- [ ] Write the welcome email
- [ ] Invite the first 50 people

\`\`\`cast
pace: fast
@maya joins
@maya types: Welcome email draft is next. Claude, can you check it against the brand notes?
@maya's Claude reads: areas/brand
@maya's Claude adds note: projects/launch/Welcome email
  # Welcome email
  You're in. Here's the 90-second tour.
@maya's Claude writes: Drafted [[welcome-email]] in the brand voice. Two lines need a date.
@jon joins
@jon adds a line below: - [ ] Line up three customers to quote
@jon's ChatGPT reads: resources/customer-interviews
@jon's ChatGPT writes: Dana, Priya and Sam all said yes in their interviews. Quotes are in [[customer-interviews]].
@sam's Codex writes: Sign-up page is built and passing. Preview link is in [[website-refresh]].
@maya types: Perfect. Locking Oct 14.
wait 3s
\`\`\`
`;

const PAGES: readonly PreviewPage[] = [
  { name: "inbox/call-with-dana", title: "Call with Dana", markdown: "# Call with Dana\n\nHappy to be quoted at launch.\n" },
  { name: "projects/launch/website-refresh", title: "Website refresh", markdown: "# Website refresh\n\nNew sign-up page.\n" },
  { name: "projects/hiring", title: "Hiring", markdown: "# Hiring\n\nTwo engineers by December.\n" },
  { name: "areas/brand", title: "Brand", markdown: "# Brand\n\nPlain words. Short sentences.\n" },
  { name: "areas/finance", title: "Finance", markdown: "# Finance\n\nRunway and pricing.\n" },
  { name: "resources/customer-interviews", title: "Customer interviews", markdown: "# Customer interviews\n\nDana, Priya, Sam.\n" },
  { name: "resources/style-guide", title: "Style guide", markdown: "# Style guide\n" },
  { name: "archive/summer-launch", title: "Summer launch", markdown: "# Summer launch\n" },
];

const ICONS: FolderIcons = {
  inbox: "📥",
  projects: "🚀",
  "projects/launch": "🗓️",
  areas: "🧭",
  resources: "📚",
  archive: "🗄️",
};

/** Where the stage loads: the homepage, with this scene as its only site. */
export function editorSceneSrc(): string {
  return `/#${castPreviewFragment(SCENE, SCENE_TITLE, PAGES, {}, ICONS)}`;
}
