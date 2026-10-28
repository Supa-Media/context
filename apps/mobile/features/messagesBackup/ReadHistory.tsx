import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";
import { useAction, useConvex } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Grow, Row } from "../design/components/Card";
import { Text } from "../design/components/Text";
import { useThemedStyles, type Colors } from "../design/theme";
import { readLine, type BackupRead } from "./view";

/** Reads listed at most; the history keeps two months, the page shows the newest. */
const SHOWN = 5;

/**
 * Who reads them, the history (board 2): the newest reads of the backup, each
 * a reader's name, a kind of read and when, from the records kept beside the
 * backup in the person's own bucket (`messagesExport.recentReads`, owner only).
 * Rows inside the "Who reads them" card, under the rule it states.
 */
export function ReadHistory(props: { workspaceId: string }) {
  // No client above it (a screen drawn from fixtures): nothing to ask, so nothing is drawn.
  return useConvex() === undefined ? null : <ReadHistoryRows {...props} />;
}

function ReadHistoryRows({ workspaceId }: { workspaceId: string }) {
  const styles = useThemedStyles(makeStyles);
  const recentReads = useAction(api.functions.messagesExport.recentReads);
  const [reads, setReads] = useState<BackupRead[] | null>(null);

  useEffect(() => {
    let live = true;
    recentReads({ workspaceId: workspaceId as Id<"workspaces"> })
      .then((found) => live && setReads(Array.isArray(found) ? found : []))
      // A history that could not be read is left out rather than shown as empty.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [recentReads, workspaceId]);

  if (reads === null) return null;
  const now = Date.now();
  return (
    <Row divided>
      <Grow>
        <Text variant="rowTitle">Lately</Text>
        {reads.length === 0 ? (
          <Text variant="rowSub" style={styles.line} testID="messages-reads-none">
            No one has read them yet.
          </Text>
        ) : (
          reads.slice(0, SHOWN).map((read, index) => (
            <Text key={`${read.at}-${index}`} variant="rowSub" style={styles.line} testID="messages-read">
              {readLine(read, now)}
            </Text>
          ))
        )}
      </Grow>
    </Row>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    line: { marginTop: 2, maxWidth: 520 },
  });
