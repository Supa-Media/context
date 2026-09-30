import { StyleSheet, View } from "react-native";
import { Card } from "../../../design/components/Card";
import { Dot } from "../../../design/components/Dot";
import { Check } from "../../../design/components/Field";
import { Pill, type PillTone } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import { relativeTime } from "../../format";
import type { ConsoleStorage } from "../../types";

/**
 * The first thing on Settings › Storage: is it working, in one word, and the
 * two checks that word rests on.
 *
 * These lines sat under the connection fields as "What this store can do",
 * worded for somebody who already knew what a conditional write was. The
 * settings cleanup (2026-09-29, approved artboard) moved them to the top and
 * said them plainly, because "is my storage OK?" is the question people open
 * this page with, and the bucket name is not the answer to it.
 *
 * Every line is still a claim about somebody's own bucket, so each one comes
 * from something that looked (#25): reachability from the binding's status,
 * which the verify probe sets by listing and writing, and safe saving from the
 * connect-time capability probe. Anything nobody measured is absent, never a
 * placeholder and never a green row.
 */
export function StorageHealth({
  storage,
  failed,
}: {
  storage: ConsoleStorage;
  /** The binding is in `error`: the last check could not use the bucket. */
  failed: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const verdict = storageVerdict(storage, failed);

  return (
    <Card testID="storage-capabilities" style={styles.card}>
      <View style={styles.head}>
        <Text variant="rowTitle" testID="storage-verdict">
          {verdict.title}
        </Text>
        <Pill tone={verdict.tone} leading={<Dot tone={verdict.tone} />}>
          {verdict.pill}
        </Pill>
      </View>
      <Text variant="rowSub" style={styles.sub}>
        From the last check of your storage, never assumed from the provider&apos;s name.
      </Text>
      <View style={styles.checks}>
        {/*
          "At the last check" is the only tense this can honestly use: a key
          revoked at the provider a minute ago still reads `connected` until
          something asks again.
        */}
        {failed ? (
          <Check tone="warn">The last check couldn&apos;t open your files</Check>
        ) : storage.connected ? (
          <Check tone="ok">
            {storage.objectCount === undefined
              ? "Context could open your files at the last check"
              : `Context could open your files at the last check (${storage.objectCount} files)`}
          </Check>
        ) : (
          <Check tone="warn">Not checked since it was connected. Press Re-verify to check.</Check>
        )}
        {storage.conditionalWrite ? (
          <Check tone="ok">Two people saving at once can&apos;t overwrite each other</Check>
        ) : (
          <Check tone="warn">
            This provider can&apos;t stop two saves at once from overwriting each other
          </Check>
        )}
        {/*
          The note count, dated from the walk that produced it; a truncated walk
          is a floor and says so. Absent is a missing row, never a zero.
        */}
        {storage.noteCount === undefined ? null : (
          <Check tone="ok">
            {`${storage.noteCount.toLocaleString("en-US")}${
              storage.noteCountTruncated ? "+" : ""
            } notes${
              storage.noteCountedAt === undefined
                ? ""
                : `, counted ${relativeTime(storage.noteCountedAt, Date.now())}`
            }`}
          </Check>
        )}
        {storage.paraPresent === undefined ? null : storage.paraPresent ? (
          <Check tone="ok">PARA structure present</Check>
        ) : (
          <Check tone="warn">No PARA folders found. Context works either way.</Check>
        )}
        {storage.versioningOn === undefined ? null : storage.versioningOn ? (
          <Check tone="ok">Versioning is on, so older versions can be recovered</Check>
        ) : (
          <Check tone="warn">
            Versioning is off. Turn it on at your provider to recover older versions.
          </Check>
        )}
      </View>
    </Card>
  );
}

/**
 * The one word at the top. "Healthy" only when both checks are green: a bucket
 * that works but cannot stop two saves colliding is working, with a limit, and
 * saying "Healthy" over an amber line is the disagreement #25 was about.
 */
export function storageVerdict(
  storage: Pick<ConsoleStorage, "connected" | "conditionalWrite">,
  failed: boolean,
): { title: string; pill: string; tone: PillTone } {
  if (failed) return { title: "Not working", pill: "Needs attention", tone: "crit" };
  if (!storage.connected) return { title: "Not checked yet", pill: "Unchecked", tone: "warn" };
  if (!storage.conditionalWrite) {
    return { title: "Working, with one limit", pill: "Working", tone: "warn" };
  }
  return { title: "Healthy", pill: "Healthy", tone: "ok" };
}

const makeStyles = () =>
  StyleSheet.create({
    card: { marginBottom: 16 },
    head: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    sub: { marginTop: 4 },
    checks: { marginTop: 15, gap: 8 },
  });
