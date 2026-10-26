import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useAction, useConvex } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../design/components/Button";
import { Card } from "../design/components/Card";
import { Text } from "../design/components/Text";
import { space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import type { useBackupStatus } from "./useBackupStatus";

/**
 * Delete the backup (board 2): a one-way step, so bold red, inline, and asked
 * twice. On the Mac app this Mac's backup is turned off and started over
 * first, so it does not copy into what was just deleted; anywhere else the
 * second ask says to turn it off there. The erasing itself runs on the server
 * (`messagesExport.deleteBackup`).
 */
export function DeleteBackup(props: { workspaceId: string; backup: ReturnType<typeof useBackupStatus> }) {
  // No client above it (a screen drawn from fixtures): nothing to ask, so nothing is drawn.
  return useConvex() === undefined ? null : <DeleteBackupRow {...props} />;
}

/** The second ask's words: where the backup goes on, said before it is too late. */
export function deleteSecondLine(onThisMac: boolean): string {
  return onThisMac
    ? "Every text and picture copied, for good, and this Mac stops backing up. Press again to delete."
    : "Every text and picture copied, for good. A Mac still backing up goes on copying new texts: turn it off there first. Press again to delete.";
}

function DeleteBackupRow({ workspaceId, backup }: { workspaceId: string; backup: ReturnType<typeof useBackupStatus> }) {
  const styles = useThemedStyles(makeStyles);
  const remove = useAction(api.functions.messagesExport.deleteBackup);
  const [armed, setArmed] = useState(false);
  const [state, setState] = useState<"idle" | "deleting" | "deleted" | "failed">("idle");
  const forget = backup.forget;

  const act = async () => {
    setState("deleting");
    try {
      if (forget !== null) await forget();
      await remove({ workspaceId: workspaceId as Id<"workspaces"> });
      setState("deleted");
      setArmed(false);
    } catch {
      setState("failed");
    }
  };

  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        disabled={state === "deleting" || state === "deleted"}
        onPress={() => (armed ? void act() : setArmed(true))}
        testID={armed ? "messages-delete-confirm" : "messages-delete"}
      >
        <Text variant="rowTitle" style={styles.danger}>
          {state === "deleting" ? "Deleting…" : "Delete the backup"}
        </Text>
        <Text variant="rowSub" style={[styles.sub, armed && styles.danger]} testID="messages-delete-line">
          {state === "deleted"
            ? "Deleted. What was copied is being erased now."
            : state === "failed"
              ? "Couldn't delete it. Try again."
              : armed
                ? deleteSecondLine(forget !== null)
                : "Every text and picture copied from your Macs. Download messages first if you want to keep a copy."}
        </Text>
      </Pressable>
      {armed && state !== "deleting" ? (
        <View style={styles.keep}>
          <Button label="Keep it" onPress={() => setArmed(false)} testID="messages-delete-keep" />
        </View>
      ) : null}
    </Card>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    danger: { color: colors.critText, fontWeight: "700" },
    sub: { marginTop: 2, maxWidth: 520 },
    keep: { marginTop: space.x3, flexDirection: "row" },
  });
