/**
 * The landing pages' sheet (`features/landing`): the Paper card's colours
 * (the link preview, PR #1237), a warm page with ink type and one blue square
 * for a full stop. The teal accent and the sign-up card stay the app's.
 */
export const lightLandingColors = {
  paper: "#EDE4D3",
  paper2: "#F6F0E4",
  hair: "#D9CFBC",
  ink: "#15171B",
  ink2: "#55534E",
  blue: "#2F7BF5",
} as const;

export type LandingColors = Readonly<
  Record<keyof typeof lightLandingColors, string>
>;

export const darkLandingColors: LandingColors = {
  paper: "#17181B",
  paper2: "#1E1F23",
  hair: "#2E2F33",
  ink: "#F1ECE3",
  ink2: "#B4ADA2",
  blue: "#4C8EF7",
};

/**
 * Tex, the mascot, wherever it is drawn: the homepage and every chaos score
 * in the app. Brand blue ink with paper-white googly eyes, as approved on the
 * homepage (Dev, 2026-10-11). Dark mode lifts the blue so it reads on a dark
 * surface; the eyes stay white, as googly eyes are.
 */
export const texColors = {
  light: { ink: "#2A45CF", eye: "#FBFAF6" },
  dark: { ink: "#8A9BF2", eye: "#FBFAF6" },
} as const;

/**
 * Page a's off-white sheet (`SimplePage.web`), after the references: ink type
 * on off-white, a grey hairline under the examples and a warm highlighter.
 * Light only (Dev, 2026-10-11: the dark version read as a different page).
 * Tex, the mascot, draws in `texColors` (its blue is the sheet's); the four AI
 * helpers on the graph each have a cursor colour (Claude, ChatGPT, Maya's
 * Codex, Jon's Claude).
 */
export const simpleLandingColors = {
  paper: "#F1F0EA",
  ink: "#1C1B19",
  ink2: "#4A4844",
  hair: "#C9C6BC",
  mark: "#DDD1BE",
  card: "#FAF9F5",
  blue: texColors.light.ink,
  agent1: "#C4572F",
  agent2: "#167A5E",
  agent3: "#6A45C2",
  agent4: "#B23F78",
} as const;
