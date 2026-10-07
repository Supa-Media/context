import { TextsLinkScreen } from "../../features/texts/TextsLinkScreen";

/**
 * `/texts/<token>`: the link the texting assistant sends a phone nobody has
 * linked. Not under the `(app)` group, for the reason `/invite/<token>` is not.
 */
export default function TextsLinkRoute() {
  return <TextsLinkScreen />;
}
