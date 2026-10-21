import { Redirect } from "expo-router";
import { useWindowDimensions } from "react-native";
import { densityFor } from "../../../features/app/frame";
import { MeetingsListScreen } from "../../../features/meetings/MeetingsListScreen";
import { useOptionalLocalSearchParams } from "../../../features/app/useOptionalLocalSearchParams";
import { MEETINGS_PANEL_HREF, MEETINGS_RECORD_HREF } from "../../../features/meetings/route";

/**
 * `/meetings` — everything this device has recorded, and what is coming up.
 *
 * A route module and nothing else, the way `(app)/console/map.tsx` is: the
 * screen owns its own scrolling surface, its own empty state and its own
 * record button, and the route's only job is to name it.
 *
 * **Only a phone gets the page.** Every other density has the console's right
 * panel, whose Meetings tab is this list, so the address sends them there —
 * the same `densityFor` question the console asks to decide whether it has a
 * panel at all. See `MEETINGS_PANEL_HREF`. The widget's
 * `?quickAction=meeting` keeps its meaning on the way: it records.
 */
export default function MeetingsRoute() {
  const { width } = useWindowDimensions();
  const { quickAction } = useOptionalLocalSearchParams<{ quickAction?: string | string[] }>();
  if (densityFor(width) !== "compact") {
    const record = (Array.isArray(quickAction) ? quickAction[0] : quickAction) === "meeting";
    return <Redirect href={record ? MEETINGS_RECORD_HREF : MEETINGS_PANEL_HREF} />;
  }
  return <MeetingsListScreen />;
}
