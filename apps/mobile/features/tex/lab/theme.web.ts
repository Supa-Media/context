/**
 * The Lab's light, dark or auto look (Dev2, 2026-11-14: "would be nice to have a dark mode/lightmode/auto toggle
 * here"). Auto follows the system; light and dark set `data-theme` on the Lab's root, which `labCss.ts` already reads.
 * The choice is this viewer's own convenience, so it lives in this browser only and the Lab works without it.
 */
import { useSyncExternalStore } from "react";

export type LabTheme = "auto" | "light" | "dark";
export const THEMES: LabTheme[] = ["auto", "light", "dark"];
const KEY = "tex-lab-theme";

const read = (): LabTheme => {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
};

let current: LabTheme | null = null;
const subs = new Set<() => void>();

export function setLabTheme(t: LabTheme) {
  current = t;
  try {
    if (t === "auto") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, t);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  for (const f of subs) f();
}

export function useLabTheme(): LabTheme {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => (current ??= read()),
    () => "auto",
  );
}
