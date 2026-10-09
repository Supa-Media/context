import { useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import type { LandingPage as Letter } from "@context/shared";
import { captureLandingPage } from "../auth/landingPage";
import { useColors, useScheme } from "../design/theme";
import { LANDING_CSS } from "./landingCss";
import { darkLandingColors as darkLanding, lightLandingColors as lightLanding } from "../design/tokens/landingColors";
import { PageA, PageB, PageC, PageD, PageE } from "./variants.web";

/**
 * The landing pages, `/` and `/a` to `/e` (Dev2, 2026-10-09): five versions
 * of the front door under test, each counted on the waitlist by the letter it
 * was (`waitlist.landing`).
 *
 * These are the one place the homepage is not the console's own shell in
 * visitor mode, which every other page of the website still is: Dev2 asked
 * for "a more typical landing page", and the map in them is the console's
 * real map engine playing a demo. See docs/decisions/websites.md.
 */
export function LandingPage({ page }: { page: Letter }) {
  const colors = useColors();
  const scheme = useScheme();
  useEffect(() => {
    // The page a visit landed on is the one its waitlist row records.
    captureLandingPage(`/${page}`);
  }, [page]);
  useEffect(() => {
    const title = document.title;
    document.title = "Context: less chaos";
    return () => {
      document.title = title;
    };
  }, []);
  const sheet = scheme === "dark" ? darkLanding : lightLanding;
  const vars = useMemo(
    () =>
      ({
        "--paper": sheet.paper,
        "--paper2": sheet.paper2,
        "--hair": sheet.hair,
        "--ink": sheet.ink,
        "--ink2": sheet.ink2,
        "--blue": sheet.blue,
        "--accent": colors.accent,
        "--ground": colors.pageSurface,
        colorScheme: scheme,
      }) as CSSProperties,
    [sheet, colors, scheme],
  );
  const Page = PAGES[page];
  return (
    <div className="lp" style={vars} data-landing={page}>
      <style>{LANDING_CSS}</style>
      <Page />
    </div>
  );
}

const PAGES: Record<Letter, () => ReactNode> = { a: PageA, b: PageB, c: PageC, d: PageD, e: PageE };
