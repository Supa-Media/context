import { texLaunchColors } from "./landingColors";

/**
 * The Tex dashboard's sheet (tex.lc/admin, `features/tex/dashboard`), in
 * tex.lc's own look (the owner, 2026-10-24: "use more of our context/tex
 * style"): the landing's paper, ink and Tex blue (`texLaunchColors`, from
 * docs/brand/README.md), its near-white cards and warm hairlines, and two
 * earth tones for what needs attention, ochre for a warning and the
 * landing's brick for something wrong. Kept beside the palette rather than
 * in it, like the landing pages' sheet: one light-only page on Tex's domain.
 */
export const texDashboardColors = {
  page: texLaunchColors.page,
  card: "#FBFAF6",
  line: "#E2DED4",
  hair: "#CFCAC0",
  tray: "#EAE7DF",
  ink: texLaunchColors.ink,
  ink2: texLaunchColors.ink2,
  ink3: "#6B6455",
  blue: texLaunchColors.blue,
  blueDeep: "#2338A8",
  blueWash: "#E4E8F7",
  bluePale: "#C3CBEF",
  ochre: "#A8671A",
  ochreWash: "#F2E5CC",
  bad: "#9A2B1F",
  badWash: "#F2DCD7",
  /** A rule on the ink panel. */
  inkRule: "#3A3C40",
} as const;
