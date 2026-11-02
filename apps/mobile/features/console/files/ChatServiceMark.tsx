import Svg, { Ellipse, Path, Rect } from "react-native-svg";
import type { ChatService } from "./chatHomeTitles";

/**
 * The app a group chat is in, drawn where its home's folder icon would be (the owner, 2026-11-02: "a drawn green
 * whatsapp logo or a drawn blue imessage logo, that way its easy to see whats imessge and whats whatsapp"). Drawn
 * here, not the companies' artwork: a blue tile with a speech bubble, and a green bubble with a handset. In the
 * apps' own colours in both themes, as `GoogleMark` is, because the colour is what tells the two apart.
 */
export function ChatServiceMark({ service, size = 16, testID }: { service: ChatService; size?: number; testID?: string }) {
  if (service === "whatsapp") {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" aria-label="WhatsApp" testID={testID ?? "chat-service-whatsapp"}>
        <Path fill="#25D366" d="M12 2.5a9 9 0 1 1-4.3 16.9L3 21l1.6-4.5A9 9 0 0 1 12 2.5z" />
        <Path
          fill="#FFFFFF"
          d="M8.6 7.2c.3-.3.8-.3 1 .1l1 1.8c.2.3.1.7-.1 1l-.6.6c.6 1.3 1.6 2.3 2.9 2.9l.6-.6c.3-.3.7-.3 1-.1l1.8 1c.4.2.4.7.1 1l-.8.8c-.6.6-1.5.8-2.3.5-2.6-1-4.6-3-5.6-5.6-.3-.8-.1-1.7.5-2.3z"
        />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" aria-label="iMessage" testID={testID ?? "chat-service-imessage"}>
      <Rect x={2} y={2} width={20} height={20} rx={5.5} fill="#0A84FF" />
      <Ellipse cx={12} cy={11.2} rx={6.8} ry={5.4} fill="#FFFFFF" />
      <Path fill="#FFFFFF" d="M7.6 14.4 6.2 18.2l4.4-2.4z" />
    </Svg>
  );
}
