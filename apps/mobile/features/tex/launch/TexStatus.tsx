import { Redirect } from "expo-router";

/** The waitlist status page is web only (`TexStatus.web.tsx`): the phone app opens on the console. */
export function TexStatus() {
  return <Redirect href="/" />;
}
