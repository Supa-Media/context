import { memo } from "react";
import { G, Path, Svg } from "react-native-svg";
import { JOB_ICON_VIEW_BOX, arc, drawnStrokes, inkFor, type Stroke } from "./jobIcons/geometry";
import type { ChatService } from "./chatHomeTitles";

/**
 * The app a group chat is in, drawn where its home's folder icon would be (the owner, 2026-11-02: "a drawn green
 * whatsapp logo or a drawn blue imessage logo, that way its easy to see whats imessge and whats whatsapp"; and, of a
 * first cut that used the apps' flat logos, "these were supposed to be drawn icons in the context/tex style").
 *
 * Drawn in the built-in folders' brush (`jobIcons/geometry.ts`), as Tex's own parts are (`contextIcons/`): an oval
 * speech bubble for iMessage, a round one with a handset in it for WhatsApp. Inked in each app's colour, the one
 * thing a drawing in the text colour could not say, in both themes.
 */
const DRAWINGS: Record<ChatService, readonly Stroke[]> = {
  // An oval bubble, its tail out of the lower left.
  imessage: [[...arc(50, 44, 38, 30, 128, 452, 20), [20, 88], [27, 68]]],
  // A round bubble, its tail out of the lower left, and a handset inside.
  whatsapp: [
    [...arc(52, 46, 36, 36, 138, 464, 20), [14, 88], [25, 70]],
    [[38, 30], [35, 42], [41, 54], [52, 62], [64, 64]],
    [[34, 30], [43, 29]],
    [[65, 60], [66, 68]],
  ],
};

const INK: Record<ChatService, string> = { imessage: "#0A84FF", whatsapp: "#25D366" };

export const ChatServiceMark = memo(function ChatServiceMark({ service, size = 16, testID }: { service: ChatService; size?: number; testID?: string }) {
  const strokes = drawnStrokes(`chat:${service}`, service, DRAWINGS[service]);
  const { width, dryWidth, dryOpacity } = inkFor(size);
  return (
    <Svg width={size} height={size} viewBox={JOB_ICON_VIEW_BOX} fill="none" aria-label={service === "whatsapp" ? "WhatsApp" : "iMessage"} testID={testID ?? `chat-service-${service}`}>
      <G stroke={INK[service]} strokeLinecap="round" strokeLinejoin="round" fill="none">
        {strokes.map((stroke, index) => (
          <G key={index}>
            <Path d={stroke.d} strokeWidth={width} />
            {dryWidth === undefined ? null : <Path d={stroke.dry} strokeWidth={dryWidth} opacity={dryOpacity} />}
          </G>
        ))}
      </G>
    </Svg>
  );
});
