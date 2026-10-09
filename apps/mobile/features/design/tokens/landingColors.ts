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

export type LandingColors = Readonly<Record<keyof typeof lightLandingColors, string>>;

export const darkLandingColors: LandingColors = {
  paper: "#17181B",
  paper2: "#1E1F23",
  hair: "#2E2F33",
  ink: "#F1ECE3",
  ink2: "#B4ADA2",
  blue: "#4C8EF7",
};
