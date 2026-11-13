import { Redirect } from "expo-router";

/**
 * `/admin/lab`, where the Tex Architecture Lab first opened on tex.lc: it is
 * at `/lab` on both hosts now (Dev2, 2026-11-13), so an old link lands there.
 * Reached by typing the address.
 */
export default function OldTexLabRoute() {
  return <Redirect href="/lab" />;
}
