import { useLocalSearchParams } from "expo-router";
import NotFound from "../+not-found";
import { firstParam } from "../../features/share/share";
import { HandleSite } from "../../features/site/HandleSite";

/** The public website homepage somebody opens from outside the app: `/@handle`. */
export default function WebsiteHomeRoute() {
  const params = useLocalSearchParams<{ handle?: string | string[] }>();
  const handle = firstParam(params.handle);
  if (handle === null || !/^@[a-z0-9][a-z0-9-]{0,62}$/i.test(handle)) {
    return <NotFound />;
  }
  return <HandleSite rawHandle={handle} segments={[]} />;
}
