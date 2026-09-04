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
 */
export default function AdminRoute() {
  return <AdminPane />;
}
