/**
 * The settings home's own sheet (Dev2, 2026-11-12, mockup v5 approved): the
 * brand's paper, hairlines and lettermark grounds from `notesLandingColors`,
 * so settings reads as Context rather than as a phone's stock grouped list.
 * The dark sheet is the landing page's dark paper with grounds deep enough to
 * carry an ink letter.
 */
export const settingsHomeColors = {
  light: {
    ground: "#F6F0E4",
    text: "#16181C",
    muted: "#55534E",
    hair: "#D9CFBC",
    buttonLine: "#B9AE97",
    ink: "#16181C",
    onInk: "#F6F0E4",
    blue: "#2F7BF5",
    danger: "#9A2B1F",
    dangerWash: "rgba(154,43,31,0.09)",
    tiles: { peach: "#F4D9C6", sage: "#CFE3D5", butter: "#F3E6B8", lilac: "#E7D7E9", sky: "#D3E5EE", tint: "#E3E8FA" },
    tileInk: "#16181C",
  },
  dark: {
    ground: "#17181B",
    text: "#F1ECE3",
    muted: "#A8A39A",
    hair: "#2E2F33",
    buttonLine: "#4A4B50",
    ink: "#F1ECE3",
    onInk: "#17181B",
    blue: "#4C8EF7",
    danger: "#F08C7C",
    dangerWash: "rgba(240,140,124,0.12)",
    tiles: { peach: "#3E2F25", sage: "#2C3A30", butter: "#3B3522", lilac: "#352D37", sky: "#26343B", tint: "#262C42" },
    tileInk: "#F1ECE3",
  },
} as const;

export type SettingsHomeColors = (typeof settingsHomeColors)["light"] | (typeof settingsHomeColors)["dark"];
