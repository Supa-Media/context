import { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { HistoryHead } from "../../tex/history/HistoryFileView";
import { HistoryFileLines } from "../../tex/history/HistoryFileLines";
import { DEFAULT_SHOWN } from "../../tex/history/historyLines";
import { fileHistorySource } from "../../tex/history/fileHistorySource";
import { ReportLink } from "../../report/ReportLink";
import { reportPersonOf, reportTargetOf, sharerLabel, type SharedItem } from "./sharedInbox";

/** The person's own Tex history file (`PERSONAL_HISTORY_FILE` in the control plane): the one non-Markdown file shared by name. */
export const SHARED_HISTORY_PATH = "tex/history.ledger.json";

/**
 * A Tex history someone shared with you, open in @shared as their chat with
 * Tex (Dev2, 2026-11-10: "Open it as Tex's chat"): the same lines and filters
 * their own History file draws, read only, from the text the grant's read
 * answered (`fileHistorySource`), never the file's JSON. It opens on every
 * day, since the chat it shows is as it was when it was opened.
 */
export function SharedHistoryView({
  text,
  item,
  phone,
  onList,
}: {
  text: string;
  item: SharedItem | null;
  phone: boolean;
  onList: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const source = useMemo(() => fileHistorySource(text), [text]);
  const who = item === null ? null : sharerLabel(item);

  return (
    <View style={styles.page} testID="shared-history">
      <View style={styles.head}>
        {phone ? (
          <PressRow accessibilityLabel="Back to Shared with me" onPress={onList} radius={radii.pill} style={styles.back} testID="shared-history-back">
            <Icon name="chevronLeft" size={16} />
          </PressRow>
        ) : (
          <PressRow accessibilityLabel="Shared with me" onPress={onList} radius={radii.sm} style={styles.crumb} testID="shared-history-root">
            <Text variant="treeMetaMono">Shared with me</Text>
          </PressRow>
        )}
        <View style={styles.grow} />
        <Pill>Can read</Pill>
        {item === null ? null : <ReportLink target={reportTargetOf(item)} person={reportPersonOf(item)} testID="shared-history-report" />}
      </View>
      <HistoryFileLines
        source={source}
        chat="me"
        // Their texts carry their name, never "You": the reader is not the person in this chat.
        group
        head={<HistoryHead whose={who === null ? null : `${who}'s chat with Tex`} />}
        pad={{ top: 0, bottom: space.x8, side: phone ? layout.readingMargin : 40 }}
        phone={phone}
        initial={{ day: "all", picked: "", shown: { ...DEFAULT_SHOWN } }}
        live={false}
        testID="shared-history-lines"
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { flex: 1, minHeight: 0 },
    head: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingHorizontal: space.x7, paddingTop: space.x3, paddingBottom: space.x2 },
    crumb: { paddingHorizontal: 2 },
    back: {
      width: 36,
      height: 36,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    grow: { flex: 1, minWidth: 0 },
  });
