import { TexPageScreen } from "../../../features/tex/page/TexPageScreen";

/**
 * `/tex/@<handle>/<view>` and `/tex/@<handle>/job/<id>`: a sub-page of the
 * person's Tex page, or one job's steps (`features/tex/page/texPlace.ts`),
 * at its own address so Tex can text a link straight to it.
 * The same screen and gate as `index.tsx`.
 */
export default function TexSubPageRoute() {
  return <TexPageScreen />;
}
