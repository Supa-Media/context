import { Platform } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { StaffConsole } from "../../../features/admin/console/StaffConsole";
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
  // On the web the console is the redesigned one, which reads its own place from the address and
  // turns an old `/admin/<tab>` into the page it became (`features/admin/console/pages/registry.ts`).
  if (Platform.OS === "web") return <StaffConsole />;
  return <NativeAdminPlace />;
}

function NativeAdminPlace() {
  const params = useLocalSearchParams<{ section?: string | string[]; days?: string }>();
  const { invalid, ...control } = useAdminPlace(params);
  // An address that names no place goes to the nearest one that exists,
  // for everybody: a non-admin is shown the same dead end there.
  if (invalid !== null) return <Redirect href={invalid} />;
  return <AdminPane {...control} />;
}
