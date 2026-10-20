import { Redirect } from "expo-router";
import { browserOrigin, googleRedirectUri } from "../../features/console/google/google";
import { CONSOLE_ROUTE } from "../../features/auth/redirect";
import { GmailFirstScreen, useGmailFirstFacts } from "../../features/auth/gmailFirst/GmailFirstScreen";

/**
 * `/add-gmail` — the link Tex texts for another Gmail (manage connect_google,
 * kind gmail): one Connect Gmail button, and the main email left as it is
 * (board 09). Under `(app)`, so the group's gates sign the person in first,
 * and an account with no email yet meets the Gmail-first gate instead.
 * Where Google cannot start it is Connected apps, as the link was before.
 */
export default function AddGmailRoute() {
  const facts = useGmailFirstFacts();
  if (facts.loading) return null;
  if (facts.workspaceId === null || googleRedirectUri(browserOrigin()) === null) return <Redirect href={CONSOLE_ROUTE} />;
  return (
    <GmailFirstScreen mode="another" workspaceId={facts.workspaceId} mainEmail={facts.mainEmail} hasGmail={facts.gmails.length > 0} />
  );
}
