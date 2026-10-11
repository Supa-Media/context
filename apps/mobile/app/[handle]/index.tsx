import { Platform } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import NotFound from "../+not-found";
import { firstParam } from "../../features/share/share";
import { homeRedirect } from "../../features/home/homeSite";
import { HandleSite } from "../../features/site/HandleSite";
import { LandingPage } from "../../features/landing/LandingPage";
import { landingFor } from "../../features/landing/route";
import { RETIRED_LANDING_PAGES } from "@context/shared";

/** The public website homepage somebody opens from outside the app: `/@handle`. */
export default function WebsiteHomeRoute() {
  const params = useLocalSearchParams<{ handle?: string | string[] }>();
  const handle = firstParam(params.handle);
  // `/a` to `/c` are the landing pages under test (Dev, 2026-10-11). Handles
  // are at least two characters, so a letter is never somebody's site.
  const landing = Platform.OS === "web" && handle !== null ? landingFor({ pathname: `/${handle}` }) : null;
  if (landing !== null) return <LandingPage page={landing} />;
  // A retired page's ad or link lands on the front door, not "Nothing here".
  if (handle !== null && RETIRED_LANDING_PAGES.includes(handle)) return <Redirect href="/" />;
  if (handle === null || !/^@[a-z0-9][a-z0-9-]{0,62}$/i.test(handle)) {
    // `/pricing` is the homepage on its Pricing page, and a name the site has
    // no page for gets the homepage's own "Nothing here". A malformed
    // handle, and anything off the web, is not found.
    const home = handle === null ? null : homeRedirect([handle], Platform.OS === "web");
    return home === null ? <NotFound /> : <Redirect href={home} />;
  }
  return <HandleSite rawHandle={handle} segments={[]} />;
}
