import { MeetingsListScreen } from "../../../features/meetings/MeetingsListScreen";

/**
 * `/meetings` — everything this device has recorded, and what is coming up.
 *
 * A route module and nothing else, the way `(app)/console/map.tsx` is: the
 * screen owns its own scrolling surface, its own empty state and its own
 * record button, and the route's only job is to name it.
 */
export default function MeetingsRoute() {
  return <MeetingsListScreen />;
}
