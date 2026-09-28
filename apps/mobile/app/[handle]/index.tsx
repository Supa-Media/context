import { Platform } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import NotFound from "../+not-found";
import { firstParam } from "../../features/share/share";
import { homeRedirect } from "../../features/home/homeSite";
import { HandleSite } from "../../features/site/HandleSite";

/** The public website homepage somebody opens from outside the app: `/@handle`. */
export default function WebsiteHomeRoute() {
  const params = useLocalSearchParams<{ handle?: string | string[] }>();
  const handle = firstParam(params.handle);
  if (handle === null || !/^@[a-z0-9][a-z0-9-]{0,62}$/i.test(handle)) {
    // `/pricing` is the homepage on its Pricing page, and a name the site has
    // no page for gets the homepage's own "Nothing here". A malformed
    // handle, and anything off the web, is not found.
    const home = handle === null ? null : homeRedirect([handle], Platform.OS === "web");
    return home === null ? <NotFound /> : <Redirect href={home} />;
  }
  return <HandleSite rawHandle={handle} segments={[]} />;
}
