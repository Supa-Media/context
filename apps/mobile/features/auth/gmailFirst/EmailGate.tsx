import { useState } from "react";
import { EmailCheckScreen } from "../EmailCheckScreen";
import { browserOrigin, googleRedirectUri } from "../../console/google/google";
import { GmailFirstScreen, useGmailFirstFacts } from "./GmailFirstScreen";

/**
 * Asked once of an account a phone made, before anything else it sees: its
 * main email. Gmail first (board 06), because Google signing them in proves
 * the address and Tex learns from that mail; "Type an email instead" is the
 * mailed code as it was (board 07). Only the typed email where Google cannot
 * start: no personal workspace to connect to, or a browser origin Google does
 * not redirect to (the phone app among them). A Gmail already connected that
 * did not become the main email (another account holds it) goes straight to
 * the typed email, rather than round again.
 */
export function EmailGate() {
  const facts = useGmailFirstFacts();
  const [typing, setTyping] = useState(false);
  if (facts.loading) return null;
  const canGmail = facts.workspaceId !== null && googleRedirectUri(browserOrigin()) !== null && facts.gmails.length === 0;
  if (!canGmail || typing) {
    return <EmailCheckScreen onUseGmail={canGmail ? () => setTyping(false) : undefined} />;
  }
  return (
    <GmailFirstScreen mode="primary" workspaceId={facts.workspaceId!} mainEmail={null} onTypeEmail={() => setTyping(true)} />
  );
}
