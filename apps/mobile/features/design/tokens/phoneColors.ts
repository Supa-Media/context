import { darkColors, lightColors, type Colors } from "./colors";

/**
 * THE PHONE'S PALETTES: APPLE NOTES CONTRAST.
 *
 * The owner, 2026-10-15: *"the color scheme makes notes extremely hard to read
 * with a screen on low brightness or under direct sunlight. needs to be more
 * contrasted like apple notes"* — and, on the board that followed, picked
 * "Phone only" (2026-10-16). A pointer layout keeps the warm paper and
 * graphite of `colors.ts`.
 *
 * So these are `colors.ts`'s palettes with their neutrals swapped for the
 * system's own: true black and white grounds, white and black ink, and a gray
 * for secondary text strong enough to read outdoors. Accents, status colours
 * and every wash stay the brand's, so nothing else on a phone changes meaning.
 *
 * Contrast (WCAG): ink on every phone surface at least 17:1 (21:1 on the
 * black and white grounds; it was 13.6:1 dark and 15.8:1 light), gray text
 * at least 7:1 (it was about 6.4:1). `theme.test.ts` holds those floors.
 */
export const darkPhoneColors: Colors = {
  ...darkColors,
  ground: "#000000",
  surface: "#000000",
  surfaceClear: "rgba(0,0,0,0)",
  surface2: "#1C1C1E",
  surface3: "#2C2C2E",
  chipFill: "rgba(255,255,255,0.06)",
  chromeMuted: "#A1A1A6",
  rowSelected: "#2C2C2E",
  line: "rgba(255,255,255,0.10)",
  lineStrong: "rgba(255,255,255,0.18)",
  text: "#FFFFFF",
  text2: "#EBEBF0",
  muted: "#B4B4BA",
  heroDim: "#8E8E93",
  chromeSurface: "#000000",
  pageSurface: "#1C1C1E",
  ink: "#000000",
  white: "#FFFFFF",
  well: "#000000",
  chrome: "#2C2C2E",
  chromePressed: "#3A3A3C",
  scrim: "rgba(0,0,0,0.60)",
};

export const lightPhoneColors: Colors = {
  ...lightColors,
  ground: "#F2F2F7",
  surface: "#FFFFFF",
  surfaceClear: "rgba(255,255,255,0)",
  surface2: "#F2F2F7",
  surface3: "#E5E5EA",
  chipFill: "rgba(0,0,0,0.05)",
  chromeMuted: "#6C6C70",
  rowSelected: "#E5E5EA",
  line: "rgba(0,0,0,0.10)",
  lineStrong: "rgba(0,0,0,0.20)",
  text: "#000000",
  text2: "#1C1C1E",
  muted: "#48484A",
  heroDim: "#6C6C70",
  chromeSurface: "#F2F2F7",
  pageSurface: "#FFFFFF",
  ink: "#FFFFFF",
  white: "#000000",
  well: "#F2F2F7",
  chrome: "#FFFFFF",
  chromePressed: "#E5E5EA",
  scrim: "rgba(0,0,0,0.22)",
};
