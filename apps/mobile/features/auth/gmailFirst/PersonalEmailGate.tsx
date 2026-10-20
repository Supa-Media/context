import { useState } from "react";
import { Platform } from "react-native";
import { EmailCheckScreen } from "../EmailCheckScreen";
import { browserOrigin, googleRedirectUri } from "../../console/google/google";
import { GmailFirstScreen, useGmailFirstFacts } from "./GmailFirstScreen";

/**
 * The personal email somebody who signed up with a work address owes, asked
 * right after their phone (Dev, 2026-10-20: "they need their number first and
 * then their personal gmail"). Drawn by `app/(app)/_layout.tsx` in place of
 * every route once setup has made their own workspace, so the link they
 * opened is drawn only after it, on the same URL.
 *
 * Gmail first, the way the one-time email gate is (`EmailGate`): Google
 * proves the address, which is added beside the work one and not made the
 * main one (`signInEmails.adoptGoogleAddress`). "Type an email instead" is the
 * mailed code. Only the typed email where Google cannot start, or once a
 * Gmail outside the work domain is connected and still was not taken (an
 * address another account holds, or past the sign-up window).
 */
export function PersonalEmailGate({ email }: { email: string | null }) {
  const facts = useGmailFirstFacts();
  const [typing, setTyping] = useState(false);
  if (facts.loading) return null;
  const domain = email === null ? null : (email.split("@")[1]?.toLowerCase() ?? null);
  const personalGmails = facts.gmails.filter((address) => address.split("@")[1]?.toLowerCase() !== domain);
  const canGmail =
    facts.workspaceId !== null && googleRedirectUri(browserOrigin()) !== null && personalGmails.length === 0;
  if (!canGmail || typing) {
    return <EmailCheckScreen personal={{ domain }} onUseGmail={canGmail ? () => setTyping(false) : undefined} />;
  }
  return (
    <GmailFirstScreen
      mode="personal"
      workspaceId={facts.workspaceId!}
      mainEmail={email}
      domain={domain ?? undefined}
      returnTo={hereOnTheWeb()}
      onTypeEmail={() => setTyping(true)}
    />
  );
}

/** The page under the gate, to come back to from Google: the link they opened. */
function hereOnTheWeb(): string | undefined {
  if (Platform.OS !== "web" || typeof window === "undefined") return undefined;
  return `${window.location.pathname}${window.location.search}`;
}
