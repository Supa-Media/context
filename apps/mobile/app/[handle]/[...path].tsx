import { useLocalSearchParams } from "expo-router";
import NotFound from "../+not-found";
import { firstParam } from "../../features/share/share";
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
    return <NotFound />;
  }
  return <HandleSite rawHandle={handle} segments={segments} />;
}
