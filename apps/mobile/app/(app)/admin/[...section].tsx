import { Redirect, useLocalSearchParams } from "expo-router";
import { AdminPane } from "../../../features/admin/AdminPane";
import { useAdminPlace } from "../../../features/admin/useAdminPlace";

/**
 * `/admin/<tab>[/<view>]` — the staff console, at the place the address names.
 *
 * Under `(app)`, so it inherits that layout's session gate and nothing here
 * has to think about signed-out callers. It does **not** inherit the console's
 * rail: this is platform-wide rather than about any one context, and putting
 * it in the rail would imply it belongs to whichever workspace is selected.
 *
 * The route exists for everyone. What it renders, and every query behind it,
 * is decided by `requireAdmin` on the server — see `AdminPane`. Which tab and
 * view, and moving between them, is `useAdminPlace`'s.
 *
 * Reached by typing the address, like `/admin` (see `./index.tsx`), or by the
 * console's own tabs once there.
 */
export default function AdminPlaceRoute() {
  const params = useLocalSearchParams<{ section?: string | string[]; days?: string }>();
  const { invalid, ...control } = useAdminPlace(params);
  // An address that names no place goes to the nearest one that exists,
  // for everybody: a non-admin is shown the same dead end there.
  if (invalid !== null) return <Redirect href={invalid} />;
  return <AdminPane {...control} />;
}
