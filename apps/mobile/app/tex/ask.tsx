import { TexAskScreen } from "../../features/tex/page/TexAskScreen";

/**
 * `/tex/ask?k=<key>`: Tex's "Go ahead?" card, answered on the web when a tap opens it outside Messages. A fixed
 * address, so it is matched before `/tex/[handle]` (which read "ask" as somebody's handle: Dev2, 2026-11-20).
 */
export default function TexAskRoute() {
  return <TexAskScreen />;
}
