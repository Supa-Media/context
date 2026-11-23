import {
  type DemoContextTree,
  folder,
  listing,
  teamFile,
} from "../../features/console/placeholderData/treeHelpers";

/**
 * A Supa-shaped workspace for the "areas as seats" review frames.
 *
 * Fake values only. The note bodies are invented review material; the names
 * are the ones the idea note (`@supa projects/backlog/areas-as-seats.md`)
 * already uses, and nothing else about any real person is said here.
 */

const team = (path: string) => folder(path, "team");

const AUDIT = `---
status: to do
area: "[[areas/engineering]]"
---
# Tex shadow code audit (2026-11-23)

Every step Tex runs should have a node in the config graph. This audit lists the steps that run in code with no node behind them, so each one either gets a node or is deleted.

## What was checked

- The gateway's agent folder, file by file, against \`texConfig.json\`.
- Every model call, by the name it logs under.
- Background jobs started from a turn.

## Findings

1. Two retries wrap a model call that the graph draws once. The graph should say it retries.
2. One summary step runs after a reply is sent and has no node at all.
3. A search fallback calls \`search_notes\` a second time with a wider prefix.

## Next

Draw the three steps in the Lab, replay last week's failures, and merge what wins.
`;

const AREA = (title: string, body: string) => `# ${title}\n\n${body}\n`;

export const SUPA_TREE: DemoContextTree = {
  listings: {
    "": listing("", "team", [
      team("inbox"),
      team("projects"),
      team("areas"),
      team("resources"),
      team("archive"),
      teamFile("index.md"),
    ]),
    inbox: listing("inbox", "team", [teamFile("inbox/voice-memo-2026-11-23.md")]),
    projects: listing("projects", "team", [
      team("projects/backlog"),
      team("projects/go-to-market"),
      team("projects/search-quality"),
      team("projects/tex-quality"),
      team("projects/tex-reliability"),
    ]),
    "projects/tex-quality": listing("projects/tex-quality", "team", [
      teamFile("projects/tex-quality/about.md"),
      teamFile("projects/tex-quality/shadow-code-audit-2026-11-23.md"),
      teamFile("projects/tex-quality/dev-set-failures.md"),
    ]),
    "projects/backlog": listing("projects/backlog", "team", [teamFile("projects/backlog/areas-as-seats.md")]),
    "projects/go-to-market": listing("projects/go-to-market", "team", []),
    "projects/search-quality": listing("projects/search-quality", "team", []),
    "projects/tex-reliability": listing("projects/tex-reliability", "team", []),
    areas: listing("areas", "team", [
      team("areas/finance"),
      team("areas/engineering"),
      team("areas/product"),
      team("areas/design"),
      team("areas/tex"),
      teamFile("areas/about.md"),
    ]),
    "areas/finance": listing("areas/finance", "team", [
      team("areas/finance/subscriptions"),
      team("areas/finance/payroll"),
      teamFile("areas/finance/about.md"),
    ]),
    "areas/engineering": listing("areas/engineering", "team", [teamFile("areas/engineering/about.md")]),
    "areas/product": listing("areas/product", "team", [teamFile("areas/product/about.md")]),
    "areas/design": listing("areas/design", "team", [teamFile("areas/design/about.md")]),
    "areas/tex": listing("areas/tex", "team", [teamFile("areas/tex/about.md")]),
    resources: listing("resources", "team", []),
    archive: listing("archive", "team", []),
  },
  notes: {
    "index.md": AREA("Supa", "Supa Media's product and team notes."),
    "inbox/voice-memo-2026-11-23.md": AREA("Voice memo", "Areas as seats."),
    "projects/tex-quality/about.md": AREA("Tex quality", "Serves [[areas/engineering]]."),
    "projects/tex-quality/shadow-code-audit-2026-11-23.md": AUDIT,
    "projects/tex-quality/dev-set-failures.md": AREA("Dev set failures", "Open cases."),
    "projects/backlog/areas-as-seats.md": AREA("Areas as seats", "The idea."),
    "areas/about.md": AREA("Company", "Owner: Seyi."),
    "areas/finance/about.md": AREA("Finance", "Owner: Seyi."),
    "areas/engineering/about.md": AREA("Engineering", "Owner: Dev2."),
    "areas/product/about.md": AREA("Product", "Owner: Seyi."),
    "areas/design/about.md": AREA("Design", "No owner yet."),
    "areas/tex/about.md": AREA("Tex", "Owner: Tex."),
  },
  defaultSelection: "projects/tex-quality/shadow-code-audit-2026-11-23.md",
  defaultExpanded: ["projects", "projects/tex-quality", "areas", "areas/finance"],
  readOnlyReason: "This is a prototype.",
};
