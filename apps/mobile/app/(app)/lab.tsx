import { TexLab } from "../../features/tex/lab/TexLab";

/**
 * `/lab` on context.lc and tex.lc: the Tex Architecture Lab (Dev2, 2026-11-13:
 * "can we make it context.lc/lab and tex.lc/lab"), staff only on the server
 * (`functions/texLab.ts`) and in the page (`amIAdmin`).
 * Reached by typing the address, like the staff console. `/admin/lab`, where
 * it opened first, redirects here. Web only: on a phone it draws nothing.
 */
export default function TexLabRoute() {
  return <TexLab />;
}
