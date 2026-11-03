import { TexPageScreen } from "../../../../features/tex/page/TexPageScreen";

/**
 * `/tex/group/<words>/<view>` and `/tex/group/<words>/job/<id>`: a sub-page of
 * a group chat's Tex page, or one job's steps (`features/tex/page/texPlace.ts`).
 * The same screen and gate as `index.tsx`.
 */
export default function TexGroupSubPageRoute() {
  return <TexPageScreen />;
}
