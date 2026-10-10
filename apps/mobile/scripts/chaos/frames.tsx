import { View } from "react-native";
import { Text } from "../../features/design/components/Text";
import { ChaosFigure } from "../../features/chaos/ChaosFigure";
import type { ChaosScore } from "../../features/chaos/chaosModel";
import type { ChaosSource } from "../../features/chaos/useChaosScore";

/**
 * The chaos score's frames: every placement drawn by the real console and
 * the real chaos components, against the demo workspace and a fixture score.
 * Fake values only.
 */

/** The workspace's score, as `chaosScore` would answer it. */
export const SCORE: ChaosScore = {
  kind: "chaosScore",
  available: true,
  score: 34,
  word: "crowded",
  weekAgo: 41,
  folders: [
    { folder: "0-inbox", items: 23, chaos: 76 },
    { folder: "3-resources/books/reading-notes", items: 14, chaos: 41 },
    { folder: "2-areas/public-worship", items: 2, chaos: 20 },
    { folder: "3-resources/books", items: 12, chaos: 33 },
    { folder: "1-projects", items: 9, chaos: 20 },
  ],
  longNotes: [
    { path: "2-areas/journal-2026.md", lines: 1420 },
    { path: "3-resources/books/reading-notes/the-power-broker.md", lines: 1085 },
  ],
  folder: null,
};

/** What each folder page is told about itself. */
const FOLDERS: Record<string, ChaosScore["folder"]> = {
  "1-projects": { folder: "1-projects", items: 12, chaos: 33 },
};

export function fixtureSource(): ChaosSource {
  return {
    result: SCORE,
    version: 1,
    folderScore: async (folder) => ({ ...SCORE, folder: FOLDERS[folder] ?? { folder, items: 5, chaos: 0 } }),
    refresh: () => {},
  };
}

export type Density = "phone" | "desktop";

export interface FrameCtx {
  density: Density;
  settle: () => Promise<void>;
  press: (node: Element | null) => void;
}

export interface ChaosFrame {
  id: string;
  title: string;
  sizes: readonly Density[];
  schemes?: readonly ("light" | "dark")[];
  /** Scroll every scroller to its end before the photograph (the phone Home's foot). */
  scroll?: boolean;
  prepare?: (ctx: FrameCtx) => Promise<void> | void;
  assert?: string[];
}

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);

/** The demo opens on a note in Projects; its breadcrumb is the way to that folder's page. */
const openProjects = async ({ density, settle, press }: FrameCtx) => {
  // A phone has no breadcrumb: its back button goes up one folder.
  press(byId(density === "phone" ? "phone-back" : "breadcrumb-folder-1-projects"));
  await settle();
};

/** A phone opens on that note; back, and back again, is Home. */
const openHome = async ({ settle, press }: FrameCtx) => {
  for (let step = 0; step < 4 && byId("phone-home") === null; step += 1) {
    press(byId("phone-back"));
    await settle();
  }
};

export const FRAMES: readonly ChaosFrame[] = [
  {
    id: "01-foot-line",
    title: "The tree's foot: one quiet line",
    sizes: ["desktop"],
    schemes: ["light", "dark"],
    assert: ["Chaos 34", "crowded"],
  },
  {
    id: "02-panel-from-foot",
    title: "The panel, over the tree",
    sizes: ["desktop"],
    prepare: async ({ settle, press }) => {
      press(byId("explorer-chaos"));
      await settle();
    },
    assert: ["Chaos 34 of 100", "Biggest wins", "Long notes", "How it’s scored"],
  },
  {
    id: "03-folder-chip",
    title: "A crowded folder's page",
    sizes: ["desktop", "phone"],
    prepare: openProjects,
    assert: ["12 items · crowded"],
  },
  {
    id: "04-panel-from-chip",
    title: "The panel from a folder's chip",
    sizes: ["desktop"],
    prepare: async (ctx) => {
      await openProjects(ctx);
      ctx.press(byId("folder-chaos-chip"));
      await ctx.settle();
    },
    assert: ["Chaos 34 of 100"],
  },
  {
    id: "05-phone-home",
    title: "The phone's Home, at its foot",
    sizes: ["phone"],
    scroll: true,
    prepare: openHome,
    assert: ["Chaos 34 · crowded"],
  },
  {
    id: "06-phone-sheet",
    title: "The panel as a sheet on a phone",
    sizes: ["phone"],
    prepare: async (ctx) => {
      await openHome(ctx);
      ctx.press(byId("phone-home-chaos"));
      await ctx.settle();
    },
    assert: ["Chaos 34 of 100"],
  },
];

/** The figure across the range, and at the sizes the surfaces draw it. */
const STRIP = [100, 90, 60, 35, 10, 1, 0] as const;

export function FigureStrip() {
  return (
    <View style={{ padding: 32, gap: 28 }} testID="chaos-figure-strip">
      <View style={{ flexDirection: "row", gap: 24 }}>
        {STRIP.map((chaos) => (
          <View key={chaos} style={{ alignItems: "center", gap: 8 }}>
            <ChaosFigure chaos={chaos} size={150} />
            <Text variant="tree">{`chaos ${chaos}`}</Text>
          </View>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 24, alignItems: "flex-end" }}>
        {STRIP.map((chaos) => (
          <View key={chaos} style={{ width: 150, alignItems: "center", gap: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 12 }}>
              <ChaosFigure chaos={chaos} size={88} />
              <ChaosFigure chaos={chaos} size={36} />
              <ChaosFigure chaos={chaos} size={18} />
            </View>
            <Text variant="treeMeta">88 · 36 · 18 px</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
