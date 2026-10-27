import { Redirect } from "expo-router";
import { DEFAULT_PLACE, adminPath } from "../../../features/admin/place";
import { isTexHost } from "../../../features/site/host";
import { TexDashboard } from "../../../features/tex/dashboard/TexDashboard";

/**
 * `/admin` — on context.lc, the staff console's front door, which is its
 * Growth tab; on tex.lc, the Tex dashboard, a page of its own (the owner,
 * 2026-10-24: "an entirely new page ... put the new dashboard in
 * tex.lc/admin"). Both hosts serve this one app, and the host decides, as it
 * does for `/` (`features/home/RootScreen.tsx`).
 *
 * On context.lc a redirect rather than a second copy of the page, so every
 * place in the console has exactly one address (`features/admin/place.ts`)
 * and the bare one is not a seventh spelling of Growth. It replaces rather
 * than pushes, so Back from `/admin/growth` does not land here and bounce
 * straight back.
 *
 * **Reached by typing the address, and by nothing else.** No rail row, no strip
 * pill, no key: putting it on one of those would say it belongs to whichever
 * context is selected, which is the thing it is not. That makes it the one
 * deliberate exception in `features/app/reachability.ts`, which requires every
 * other route under `(app)` to have a control leading to it at every density —
 * the guard that would have caught a phone losing its only route to
 * `/meetings`. Anything added here needs a way in or an entry on that list.
 */
export default function AdminRoute() {
  if (isTexHost()) return <TexDashboard />;
  return <Redirect href={adminPath(DEFAULT_PLACE)} />;
}
