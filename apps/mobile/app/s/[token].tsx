import { ShareScreen } from "../../features/share/ShareScreen";

/**
 * `/s/<token>` — the link an owner pasted into a chat.
 *
 * Outside the `(app)` group on purpose; see `_layout.tsx` beside this file.
 * The path of a linked note rides in `?path=`, so the token names what the
 * reader has access to and the query names where they are inside it.
 */
export default function ShareTokenRoute() {
  return <ShareScreen />;
}
