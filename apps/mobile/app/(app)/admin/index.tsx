import { AdminPane } from "../../../features/admin/AdminPane";

/**
 * `/admin` — the staff console.
 *
 * Under `(app)`, so it inherits that layout's session gate and nothing here
 * has to think about signed-out callers. It does **not** inherit the console's
 * rail: this is platform-wide rather than about any one context, and putting
 * it in the rail would imply it belongs to whichever brain is selected.
 *
 * The route exists for everyone. What it renders, and every query behind it,
 * is decided by `requireAdmin` on the server — see `AdminPane`.
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
  return <AdminPane />;
}
