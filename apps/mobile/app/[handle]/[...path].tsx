import { Platform } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import NotFound from "../+not-found";
import { firstParam } from "../../features/share/share";
import { homeRedirect } from "../../features/home/homeSite";
import { HandleSite } from "../../features/site/HandleSite";

/**
 * Website routes at `/@handle/...`, including the legacy marker
 * `/@seyi/intake` and nested `/@handle/guides/getting-started` pages.
 * This is the public website path or compatibility short link somebody was handed.
 */
export default function NestedWebsiteRoute() {
  const params = useLocalSearchParams<{
    handle?: string | string[];
    path?: string | string[];
  }>();
  const path = params.path;
  const segments = Array.isArray(path)
    ? path
    : path === undefined
      ? []
      : [path];
  const handle = firstParam(params.handle);
  if (handle === null || !/^@[a-z0-9][a-z0-9-]{0,62}$/i.test(handle)) {
    // `/pricing` is the homepage on its Pricing page, and a name the site has
    // no page for gets the homepage's own "Nothing here". A malformed
    // handle, and anything off the web, is not found.
    const home = handle === null ? null : homeRedirect([handle, ...segments], Platform.OS === "web");
    return home === null ? <NotFound /> : <Redirect href={home} />;
  }
  return <HandleSite rawHandle={handle} segments={segments} />;
}
