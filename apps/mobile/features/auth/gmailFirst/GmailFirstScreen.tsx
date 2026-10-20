import { ActivityIndicator, View, useWindowDimensions } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../../design/components/Button";
import { CenteredScroll } from "../../design/components/CenteredScroll";
import { FormError } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles } from "../../design/theme";
import { useGoogleStart } from "../../console/google/useGoogleStart";
import { GoogleMark } from "./GoogleMark";
import { GMAIL_SERVICES, googleWarning, rememberGmailFirst, type GmailFirstMode } from "./gmailFirst";
import { makeGmailStyles } from "./gmailStyles";

export const GMAIL_FIRST_TITLE = "Connect your personal Gmail";
export const GMAIL_FIRST_WHY =
  "Use the one you check most. It becomes your main email on Context: invitations go to it, and it gets you back in if you lose your phone.";
export const GMAIL_FIRST_TEX = "Tex reads your recent mail to get to know you. You'll keep signing in with your phone.";
export const ADD_GMAIL_TITLE = "Add another Gmail";
export const ADD_GMAIL_WHY = "Connect the Gmail you want to add, like a work or side-project one. Tex reads its recent mail too.";
/** `/add-gmail` for somebody whose main email was typed, with no Gmail yet. */
export const FIRST_GMAIL_TITLE = "Connect your Gmail";
export const FIRST_GMAIL_WHY = "Use the one you check most. Tex reads your recent mail to get to know you.";
/** `personal`: somebody who signed up with a work address, after their phone. */
export function personalGmailWhy(domain: string | null): string {
  return `Use the one you check most. It keeps your account yours ${domain === null ? "if your work email goes away" : `if you leave ${domain}`}.`;
}
export const PERSONAL_GMAIL_TEX = "Tex reads your recent mail to get to know you.";

/**
 * One button to Google, worded for the Gmail it asks for (board 06, 09):
 *
 *  - `primary`, the one-time gate of an account a phone made: their personal
 *    Gmail, which becomes their main email (`signInEmails.adoptGoogleAddress`),
 *    with "Type an email instead" for anybody who would rather not;
 *  - `another`, `/add-gmail`, the link Tex texts for a work or side-project
 *    Gmail: the main email stays as it is;
 *  - `personal`, after a work-domain sign-up's phone: their personal Gmail,
 *    added beside the work address (`signInEmails.adoptGoogleAddress`), and
 *    Google brings them back to `returnTo`, the link they opened.
 *
 * Google's unverified-app warning is explained under the button, where it
 * happens. Where Google cannot start (no personal workspace yet, or an origin
 * Google does not redirect to) the gate is the typed email instead
 * (`EmailGate`), and this page is never drawn.
 */
export function GmailFirstScreen({
  mode,
  workspaceId,
  mainEmail,
  hasGmail = true,
  onTypeEmail,
  domain,
  returnTo,
}: {
  mode: GmailFirstMode;
  /** `personal` only: the work domain they signed up with. */
  domain?: string;
  /** `personal` only: the page to come back to once Google is done. */
  returnTo?: string;
  workspaceId: string;
  mainEmail: string | null;
  /** `another` only: false when no Gmail is connected yet, so it is not "another". */
  hasGmail?: boolean;
  onTypeEmail?: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeGmailStyles);
  const { width } = useWindowDimensions();
  const google = useGoogleStart(workspaceId);
  const busy = google.state.kind === "starting";

  const connect = () => {
    if (busy) return;
    rememberGmailFirst(mode, returnTo);
    google.start(GMAIL_SERVICES);
  };

  return (
    <View style={styles.ground}>
      <CenteredScroll testID="gmail-first">
        <View style={styles.form}>
          <Text variant="mark" style={styles.mark}>
            Context
            <Text variant="mark" style={styles.markSuffix}>
              .lc
            </Text>
          </Text>
          <Text role="heading" aria-level={1} style={styles.pitch}>
            {mode !== "another" ? GMAIL_FIRST_TITLE : hasGmail ? ADD_GMAIL_TITLE : FIRST_GMAIL_TITLE}
          </Text>
          {mode === "personal" ? (
            <>
              <Text style={styles.body}>{personalGmailWhy(domain ?? null)}</Text>
              <Text style={styles.body}>{PERSONAL_GMAIL_TEX}</Text>
            </>
          ) : mode === "primary" ? (
            <>
              <Text style={styles.body}>{GMAIL_FIRST_WHY}</Text>
              <Text style={styles.body}>{GMAIL_FIRST_TEX}</Text>
            </>
          ) : (
            <>
              <Text style={styles.body}>{hasGmail ? ADD_GMAIL_WHY : FIRST_GMAIL_WHY}</Text>
              {mainEmail !== null ? (
                <Text style={styles.body}>
                  Your main email stays <Text style={styles.strong}>{mainEmail}</Text>.
                </Text>
              ) : null}
            </>
          )}
          <View style={styles.primaryRow}>
            <Button
              label="Connect Gmail"
              variant="accent"
              disabled={busy || google.redirectUri === null}
              onPress={connect}
              leading={busy ? <ActivityIndicator color={colors.ink} size="small" /> : <GoogleMark />}
              testID="gmail-first-connect"
            />
          </View>
          <Text variant="foot" style={styles.foot}>
            {googleWarning(width < 700)}
          </Text>
          {google.state.kind === "failed" ? (
            <View style={styles.error}>
              <FormError headline={google.state.headline} next={google.state.message} />
            </View>
          ) : null}
          {onTypeEmail ? (
            <Text variant="foot" role="link" style={styles.link} onPress={onTypeEmail} testID="gmail-first-type-email">
              Type an email instead
            </Text>
          ) : null}
        </View>
      </CenteredScroll>
    </View>
  );
}

/**
 * The one-time email gate (`app/(app)/_layout.tsx`): Gmail first, the typed
 * email a tap away, and only the typed email where Google cannot start.
 */
export function useGmailFirstFacts(): { loading: boolean; workspaceId: string | null; mainEmail: string | null; gmails: string[] } {
  const home = useQuery(api.functions.texHome.mine, {});
  return {
    loading: home === undefined,
    workspaceId: home?.workspaceId ?? null,
    mainEmail: home?.mainEmail ?? null,
    gmails: home?.gmails ?? [],
  };
}
