import { useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { Card, Grow, Row } from "../design/components/Card";
import { Switch } from "../design/components/Switch";
import { Text } from "../design/components/Text";
import { space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { useCanSendFeedback } from "./transport";
import {
  setPreferences,
  useTelemetryPreferences,
  type TelemetryPreferences,
} from "../observability/preferences";
import { settingsSectionLabel } from "../console/settings/sections";
import { openFeedback } from "./request";

/**
 * Settings → Feedback: the same sentences as the early-beta notice,
 * and a switch for each thing it describes.
 *
 * No shake row: shake-to-report needs a native module this build does not
 * carry, and a row that cannot work is left out rather than greyed.
 */
export function FeedbackSettings() {
  const styles = useThemedStyles(makeStyles);
  const prefs = useTelemetryPreferences();
  const canReport = useCanSendFeedback();
  const [failed, setFailed] = useState(false);

  const change = (patch: Partial<TelemetryPreferences>) => {
    setFailed(false);
    // The stored value is the truth: the switch moves when the write lands,
    // and stays where it was when it does not.
    setPreferences(patch).catch(() => setFailed(true));
  };

  const loading = prefs === null;
  const web = Platform.OS === "web";

  // Tex conversations are the account's alone: no device copy, off until they say yes (`functions/texReviews.ts`).
  const { isAuthenticated } = useConvexAuth();
  const sharing = useQuery(api.functions.texReviews.myTexReviewSharing, isAuthenticated ? {} : "skip");
  const setSharing = useMutation(api.functions.texReviews.setMyTexReviewSharing);
  const changeSharing = (share: boolean) => {
    setFailed(false);
    setSharing({ share }).catch(() => setFailed(true));
  };

  return (
    <View>
      <Text variant="paneTitle" role="heading" aria-level={2} style={styles.head}>
        {settingsSectionLabel("feedback")}
      </Text>
      <Text variant="paneSub" style={styles.sub}>
        Context is in early beta. These help us find and fix problems. They follow your
        account to every device you sign in on.
      </Text>

      <Card>
        <SettingRow
          first
          title="Crash reports"
          sub="What went wrong and on which screen, with names and text removed."
          value={prefs?.crashReports ?? true}
          disabled={loading}
          onChange={(crashReports) => change({ crashReports })}
          testID="privacy-crash-reports"
        />
        <SettingRow
          title="Screen counts"
          sub="Which screens and buttons get used, and for how long, linked to your account, not your name or email."
          value={prefs?.screenCounts ?? true}
          disabled={loading}
          onChange={(screenCounts) => change({ screenCounts })}
          testID="privacy-screen-counts"
        />
        {web ? (
          <SettingRow
            title="Screen recordings, words hidden"
            sub={
              prefs?.screenCounts === false
                ? "Off while screen counts are off."
                : "Some visits, with every word and picture hidden."
            }
            value={(prefs?.recordings ?? true) && prefs?.screenCounts !== false}
            disabled={loading || prefs?.screenCounts === false}
            onChange={(recordings) => change({ recordings })}
            testID="privacy-recordings"
          />
        ) : null}
      </Card>

      {isAuthenticated ? (
        <Card style={styles.texCard}>
          <SettingRow
            first
            title="Share finished Tex conversations"
            sub="When a conversation with Tex ends, the Context team can read it, with a score of how it went, to make Tex better. Off unless you turn it on. With it off, only the scores are kept, with no words and no name."
            value={sharing === true}
            disabled={sharing === undefined || sharing === null}
            onChange={changeSharing}
            testID="privacy-tex-conversations"
          />
        </Card>
      ) : null}

      {failed ? (
        <Text variant="hint" style={styles.problem} testID="privacy-save-failed">
          Couldn't save that change. Try again.
        </Text>
      ) : null}

      <View style={styles.never}>
        <Text variant="rowSub">
          <Text variant="rowTitle">Never collected: </Text>
          note text, titles, folder names, links, your email or your @handle, unless you put
          them in a report yourself, or share Tex conversations above.
        </Text>
      </View>

      {canReport ? (
        <View style={styles.action}>
          <Button label="Send feedback" onPress={() => openFeedback("settings")} testID="privacy-send-feedback" />
        </View>
      ) : null}
    </View>
  );
}

function SettingRow({
  first = false,
  title,
  sub,
  value,
  disabled,
  onChange,
  testID,
}: {
  first?: boolean;
  title: string;
  sub: string;
  value: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Row divided={!first}>
      <Grow>
        <Text variant="rowTitle">{title}</Text>
        <Text variant="rowSub" style={styles.rowSub}>
          {sub}
        </Text>
      </Grow>
      <Switch value={value} onValueChange={onChange} label={title} disabled={disabled} testID={testID} />
    </Row>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { marginBottom: 4 },
    texCard: { marginTop: space.x3 },
    sub: { marginBottom: space.x3, maxWidth: 546 },
    rowSub: { marginTop: 2, maxWidth: 520 },
    problem: { marginTop: space.x2, color: colors.critText },
    never: {
      marginTop: space.x3,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 8,
      backgroundColor: colors.surface3,
    },
    action: { marginTop: space.x3, alignItems: "flex-start" },
  });
