import { useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import type { LandingPage as Letter } from "@context/shared";
import { captureLandingPage } from "../auth/landingPage";
import { useColors, useScheme } from "../design/theme";
import { LANDING_CSS } from "./landingCss";
import { darkLandingColors as darkLanding, lightLandingColors as lightLanding } from "../design/tokens/landingColors";
import { HomeShell } from "../home/HomeShell";
import { PageA, PageB } from "./variants.web";

/**
 * The landing pages, `/` and `/a` to `/c` (Dev, 2026-10-11, replacing the
 * five of 2026-10-09): three versions of the front door under test, each
 * counted on the waitlist by its letter (`waitlist.landing`) and by the ad
 * that sent the visit (`waitlist.campaign`).
 *
 * a is the simple one and b the map, both plain pages in the Paper sheet. c
 * is the console's own shell in visitor mode, the homepage every other page
 * of the website still is, so "the landing page was the app shell" is that
 * shell itself rather than a picture of it. See docs/decisions/websites.md.
 */
export function LandingPage({ page }: { page: Letter }) {
  useEffect(() => {
    // The page a visit landed on is the one its waitlist row records.
    captureLandingPage(`/${page}`);
  }, [page]);
  return page === "c" ? <HomeShell /> : <PaperPage page={page} />;
}

/** a and b: one page in the landing sheet. */
function PaperPage({ page }: { page: Exclude<Letter, "c"> }) {
  const colors = useColors();
  const scheme = useScheme();
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

const PAGES: Record<Exclude<Letter, "c">, () => ReactNode> = { a: PageA, b: PageB };
