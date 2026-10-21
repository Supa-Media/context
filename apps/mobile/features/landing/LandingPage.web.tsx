import { useEffect, useMemo, type CSSProperties } from "react";
import type { LandingPage as Letter } from "@context/shared";
import { captureLandingPage } from "../auth/landingPage";
import { useColors, useScheme } from "../design/theme";
import { LANDING_CSS } from "./landingCss";
import { darkLandingColors as darkLanding, lightLandingColors as lightLanding } from "../design/tokens/landingColors";
import { HomeShell } from "../home/HomeShell";
import { NotesPage } from "./NotesPage.web";
import { PageB } from "./variants.web";

/**
 * The landing pages, `/` and `/a` to `/c` (Dev, 2026-10-11, replacing the
 * five of 2026-10-09): three versions of the front door under test, each
 * counted on the waitlist by its letter (`waitlist.landing`) and by the ad
 * that sent the visit (`waitlist.campaign`).
 *
 * a is the notes page: the editor, workspaces for free, and Tex linking to
 * tex.lc (Dev2, 2026-10-21, replacing the Tex page now tex.lc has its own). b is the
 * page `/` showed until today, unchanged, with the map at its centre. c is
 * the console's own shell in visitor mode, the homepage every other page of
 * the website still is, so "the landing page was the app shell" is that shell
 * itself rather than a picture of it. See docs/decisions/websites.md.
 */
export function LandingPage({ page }: { page: Letter }) {
  useEffect(() => {
    // The page a visit landed on is the one its waitlist row records.
    captureLandingPage(`/${page}`);
  }, [page]);
  if (page === "a") return <NotesPage />;
  return page === "c" ? <HomeShell /> : <PaperPage />;
}

/** b: the map page, in the landing sheet. */
function PaperPage() {
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
  return (
    <div className="lp" style={vars} data-landing="b">
      <style>{LANDING_CSS}</style>
      <PageB />
    </div>
  );
}
