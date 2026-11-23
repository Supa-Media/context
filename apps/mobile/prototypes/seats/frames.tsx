/** The shells the clickable prototype is built on: the real console, pressed open to where the script takes over. */

export type Density = "phone" | "desktop";

export interface FrameCtx {
  density: Density;
  settle: () => Promise<void>;
  press: (node: Element | null) => void;
}

export interface SeatsFrame {
  id: string;
  title: string;
  sizes: readonly Density[];
  schemes?: readonly ("light" | "dark")[];
  prepare?: (ctx: FrameCtx) => Promise<void> | void;
  assert?: string[];
}

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);

const treeRow = (name: string) =>
  [...document.querySelectorAll('[data-testid="explorer-tree"] button')].find((b) => b.textContent?.trim() === name) ?? null;

export const FRAMES: SeatsFrame[] = [
  {
    id: "areas",
    title: "The areas folder open in the editor, the panel open beside it",
    sizes: ["desktop"],
    prepare: async ({ settle, press }) => {
      press(treeRow("areas"));
      await settle();
      press(treeRow("areas"));
      await settle();
      press(byId("aside-strip-areas"));
      await settle();
    },
  },
  {
    id: "shell",
    title: "Console with the Areas panel open",
    sizes: ["desktop", "phone"],
    prepare: async ({ density, settle, press }) => {
      if (density === "desktop") {
        press(byId("aside-strip-areas"));
        await settle();
      }
    },
  },
];
