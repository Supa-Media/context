import { Redirect } from "expo-router";
import { DEFAULT_PLACE, adminPath } from "../../../features/admin/place";
import { isTexHost } from "../../../features/site/host";
import { TexLab } from "../../../features/tex/lab/TexLab";

/**
 * `/admin/lab` on tex.lc: the Tex Architecture Lab (Dev2, 2026-11-13), staff
 * only on the server (`functions/texLab.ts`). Reached by typing the address,
 * like tex.lc/admin beside it. On context.lc there is no Lab, so the address
 * goes to the staff console's front door.
 */
export default function TexLabRoute() {
  if (isTexHost()) return <TexLab />;
  return <Redirect href={adminPath(DEFAULT_PLACE)} />;
}
