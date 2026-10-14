import { useMemo, useState } from "react";
import { View } from "react-native";
import { Palette } from "../design/components/Palette";
import { WorkspaceChips } from "../console/layout/EverywhereBar";
import { workspaceFilters } from "../console/layout/searchFilters";
import type { PaletteItem } from "../console/files/palette";
import type { SearchableContext } from "../console/search/results";

/**
 * ⌘K's `in:` filter, workspace chips and rows on invented workspaces, for
 * looking at in a real browser: the chips' spacing, the field without a focus
 * ring, the rows without a glyph. The search behind them is not here (it needs
 * a deployment); `paletteRender/filters.test.ts` pins the behaviour.
 */
const CONTEXTS: SearchableContext[] = ["acme", "jo", "bandmates"].map((slug, index) => ({
  workspaceId: `fixture-${index}`,
  slug,
  displayName: ["Acme Ltd", "Jo Example", "The Band"][index],
  search: "fast",
  fastSearch: "on",
  owner: index === 1,
}));

const RECENT: PaletteItem[] = [
  { id: "1-projects/launch/plan.md", label: "Launch plan", detail: "Projects/launch", kind: "note" },
  { id: "2-areas/home/garden.md", label: "Garden beds", detail: "Areas/home", kind: "note" },
  { id: "3-resources/reading.md", label: "Reading list", detail: "Resources", kind: "note" },
];

export function PaletteFilterFixture() {
  const [narrowed, narrow] = useState<string | null>(null);
  const filters = useMemo(() => workspaceFilters(CONTEXTS, narrowed, narrow), [narrowed]);
  return (
    <View style={{ flex: 1 }}>
      <Palette
        items={RECENT}
        recent={RECENT}
        emptyHeading="Recent"
        placeholder="Search"
        scopeBar={<WorkspaceChips contexts={CONTEXTS} narrowed={narrowed} onNarrow={narrow} />}
        filters={filters}
        onChoose={() => {}}
        onDismiss={() => {}}
      />
    </View>
  );
}
