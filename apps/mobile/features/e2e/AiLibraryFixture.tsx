import { useMemo, useState } from "react";
import { AdminChrome } from "../admin/AdminPane";
import { Library, type AiView } from "../admin/AiSection";
import { ConsoleHeader } from "../admin/ConsoleHeader";
import { buildCatalog, type FolderNote } from "../admin/aiCatalog";
import { AiNoteIoContext, type AiNoteIo } from "../admin/useAiNote";

/**
 * The staff console's AI tab on an in-memory `ai/` folder, for reviewing the
 * design in a browser: `?screen=ai&at=<view>`, and `&open=<path>` to open a
 * note in place. Reads and saves go to the map below, never to a bucket.
 */
const props = (properties: Record<string, unknown>, heading: string, lede = "") => JSON.stringify({ properties, heading, lede });
const day = Date.now() - 86_400_000;

const NOTES: FolderNote[] = [
  { path: "ai/production/texting-assistant.md", updatedAt: day, props: props({ job: "texting-assistant", models: { main: "anthropic/claude-haiku-5-5", smart: "anthropic/claude-opus-5-5" } }, "Tex") },
  { path: "ai/production/app-assistant.md", updatedAt: day * 0.99999, props: props({ job: "app-assistant", models: { main: "anthropic/claude-haiku-5-5" } }, "App assistant") },
  { path: "ai/production/skills/build-a-website.md", updatedAt: day, props: props({}, "Make, change or publish their website", "You set the site up. They write it.") },
  { path: "ai/production/skills/connect-claude.md", updatedAt: day, props: props({ reach: ["tex", "mcp"] }, "Connect Claude to Context", "Do it yourself in your browser.") },
  { path: "ai/production/skills/save-a-login.md", updatedAt: day, props: props({}, "Save a login or a key for them") },
  { path: "ai/production/skills/email/reply-to-a-thread.md", updatedAt: day, props: props({ reach: ["tex", "mcp"] }, "Reply to a thread", "Answer an email in its own thread.") },
  { path: "ai/tests/core.md", updatedAt: day, props: props({ job: "texting-assistant", covers: ["build-a-website"] }, "Core", "The basics Tex must do.") },
  { path: "ai/tests/search.md", updatedAt: day, props: props({ job: "search" }, "Search") },
  { path: "ai/setups/texting-assistant/live-5-2026-10-14.md", updatedAt: day, props: props({ job: "texting-assistant" }, "live-5") },
  { path: "ai/results/2026-10-14 core gh-33 scores.md", updatedAt: day, props: props({}, "texting-assistant, 2026-10-14: scores") },
  { path: "ai/about.md", updatedAt: day, props: props({}, "AI", "Everything the AIs in Context run on.") },
];

const TEXTS: Record<string, string> = {
  "ai/production/skills/build-a-website.md": "---\nreach: [tex]\n---\n\n# Make, change or publish their website\n\nYou set the site up. They write it. Never fill a page with words they didn't give you.\n\n- Check the site before publishing.\n",
  "ai/tests/core.md": [
    "---",
    "job: texting-assistant",
    "covers: [build-a-website]",
    "---",
    "",
    "# Core",
    "",
    "## 1. When's my dentist appointment?",
    "",
    "A lookup from one note.",
    "",
    "- kind: task",
    "- must: say Tuesday, October 13 at 3 pm",
    "- must not: make up a date that isn't in the notes",
    "",
    "## 5. what do I need to do before lisbon",
    "",
    "- kind: task",
    "- person starts: what do I need to do before lisbon",
    "- if asked which list: the Lisbon one",
    "- must: give the Lisbon to-dos from her list",
    "- must not: invent a to-do that isn't in the notes",
    "- must write: maya/todo.md",
    "",
  ].join("\n"),
  "ai/results/2026-10-14 core gh-33 scores.md": [
    "## Scored by claude-haiku-5-5, 2026-10-14",
    "",
    "| setup | score | gates | judge lines | price | speed | texts | errors | good enough |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| production | 93.3% | failed (q5) | 203 of 225 | $0.0177 | 6.6 s | 1.2 | 0 | no |",
    "",
    "Why gates failed, production:",
    '- q5 must not "invent a to-do that isn\'t in the notes": 1 of 3 runs',
    "",
  ].join("\n"),
};

export function AiLibraryFixture({ at, open }: { at?: string; open?: string }) {
  const [view, setView] = useState<AiView>((at as AiView | undefined) ?? "attention");
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
        <Library workspaceId={"fixture" as never} catalog={catalog} view={view} onView={setView} onSaved={() => {}} days={30} initialOpen={open} />
      </AdminChrome>
    </AiNoteIoContext.Provider>
  );
}
