import { useState } from "react";
import { Text, View } from "react-native";
import { Palette } from "../design/components/Palette";
import { NotePreview, type NoteReader } from "../console/layout/NotePreview";
import type { PaletteItem } from "../console/files/palette";

/**
 * ⌘K's answered search on invented notes, for looking at in a real browser
 * (boards A and B1, leadership weekly 2026-10-17): three-line rows with the
 * words in bold, the reason counting words, the preview on a wide window and
 * Tab's "show only these names in the tree". The search behind them needs a
 * deployment and is not here; the rows are what `itemsFromBlended` makes.
 *
 * Names and snippets are long on purpose: a row that only looks right with
 * short words has not been checked.
 */
const DAY = 86_400_000;
const NOW = Date.now();

const workspace = (slug: string, index: number) => ({ slug, current: index === 0, id: `fixture-${index}` });

const ANSWERS: PaletteItem[] = [
  {
    id: "1-projects/launch/pricing-plan-for-the-spring-launch-and-the-partner-programme.md",
    label: "Pricing plan for the spring launch and the partner programme",
    detail: "@acme · Projects/launch",
    kind: "note",
    why: "name",
    reason: "In the name",
    workspace: workspace("acme", 0),
    edited: NOW,
    snippet:
      "Decided the pricing plan stays at one tier for the launch; partners get the yearly price with the first three months free, and we revisit after the first hundred accounts.",
  },
  {
    id: "2-areas/finance/board-meeting-notes-september.md",
    label: "Board meeting notes, September",
    detail: "@acme · Areas/finance",
    kind: "note",
    why: "words",
    reason: "Has all 3 words",
    workspace: workspace("acme", 0),
    edited: NOW - DAY,
    snippet:
      "The board asked for the launch pricing before the October meeting, and wanted the plan to show what happens to the spring cohort if partners churn in the first quarter.",
  },
  {
    id: "1-projects/website/homepage-copy-drafts-with-a-very-long-name-that-keeps-going.md",
    label: "Homepage copy drafts with a very long name that keeps going past the end of the row",
    detail: "@jo · Projects/website/drafts/second round/after feedback",
    kind: "note",
    why: "words",
    reason: "Has 2 of 3 words",
    workspace: workspace("jo", 1),
    edited: NOW - 40 * DAY,
    snippet:
      "Hero line options for launch week. Option three mentions pricing up front, which tested better with the people we asked, but it crowds the subtitle on a phone.",
  },
  {
    id: "3-resources/reading/how-other-companies-charge.md",
    label: "How other companies charge",
    detail: "@bandmates · Resources/reading",
    kind: "note",
    why: "meaning",
    reason: "Same topic, different words",
    workspace: workspace("bandmates", 2),
    edited: NOW - 400 * DAY,
    snippet:
      "A collection of what similar tools ask people to pay: per seat, per workspace, flat yearly, and the ones that give the first year away to get a foot in the door.",
  },
];

const NOTE = `---
status: active
---
# Pricing plan for the spring launch

One tier at launch. The pricing page shows the yearly price first, with the monthly price under it.

## Partners

- Partners get the yearly price with the first three months free.
- [[Partner list|The partner list]] is in the launch folder.
- We revisit the plan after the first hundred accounts.

## Open questions

What happens to the spring cohort if a partner leaves in the first quarter? The board wants an answer before October.
`;

const read: NoteReader = async (_workspaceId, path) =>
  path.startsWith("3-resources/") ? { text: "", encrypted: true } : { text: NOTE };

export function PaletteResultsFixture() {
  const [narrowed, setNarrowed] = useState<string | null>(null);
  return (
    <View style={{ flex: 1 }}>
      {narrowed === null ? null : <Text testID="fixture-narrowed">{narrowed}</Text>}
      <Palette
        items={[]}
        placeholder="Search notes and names"
        search={{ onQuery: () => {}, items: ANSWERS, state: "ready", ranked: true }}
        preview={(item, query) => <NotePreview item={item} query={query} read={read} />}
        onNarrowTree={setNarrowed}
        onChoose={() => {}}
        onDismiss={() => {}}
      />
    </View>
  );
}
