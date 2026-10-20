import { Redirect } from "expo-router";

/** `/text` is tex.lc's, web only (`TexText.web.tsx`): the phone app opens on the console. */
export function TexText() {
  return <Redirect href="/" />;
}
