/**
 * The human check in front of the one page a stranger can write through.
 *
 * ## Native: there isn't one, and that is said rather than worked around
 *
 * Cloudflare Turnstile is a browser widget. There is no native equivalent, and
 * the server refuses a submission with no verified token — correctly, because
 * a route whose defence depends on which client asked has no defence. So the
 * native build of this component yields no token, ever, and the form it sits
 * in says to open the link in a browser.
 *
 * That is the honest failure. The dishonest ones would be a native form that
 * collects two minutes of somebody's typing and is refused at the end, or a
 * server that waved a submission through because it came from an app.
 *
 * The web counterpart is `HumanCheck.web.tsx`, which is where the widget is.
 */

import { Text } from "../design/components/Text";
import { Notice } from "../design/components/Input";

/**
 * Whether this build can produce a challenge token at all.
 *
 * Read by the form *before* it draws its fields, so "you cannot answer here"
 * arrives before the typing rather than after it.
 */
export const HUMAN_CHECK_AVAILABLE = false;

export function HumanCheck(_props: {
  /** Called with a token when the check passes, and `null` when it lapses. */
  onToken: (token: string | null) => void;
  /** Bumped by the form after a send, to ask for a fresh token. */
  resetKey: number;
}) {
  return (
    <Notice tone="warn" testID="share-form-no-human-check">
      <Text variant="rowSub">
        Open this link in a web browser to answer the form.
      </Text>
    </Notice>
  );
}
