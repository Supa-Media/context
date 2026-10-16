/**
 * One workspace's shared-id check on the Notes by id page (`./NoteIdsView`):
 * "Check for shared ids" reads every page of the report, then says how many
 * notes share an id with another note, with a Fix button that is enabled only
 * when there are some. Groups the repair will not touch (a keyed workspace's
 * group with a row at the shared key) are listed by path underneath.
 *
 * The report is `api.functions.noteIds.sharedIdReport` (paged; this view reads
 * every page) and the fix is `api.functions.noteIds.repairSharedIds`, which only
 * schedules the repair. The words are `./noteIds`.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useConvex, useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Text, space, useThemedStyles, type Colors } from "../design";
import { messageFor } from "./SecretDialogs";
import { needsLookLines, sharedIdsLine } from "./noteIds";

type Found = { count: number; looks: string[][] };

export function SharedIdsCheck({ workspaceId }: { workspaceId: string }) {
  const styles = useThemedStyles(makeStyles);
  const convex = useConvex();
  const repair = useMutation(api.functions.noteIds.repairSharedIds);
  const [checking, setChecking] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  async function check() {
    setChecking(true);
    setSaid(null);
    try {
      const id = workspaceId as Id<"workspaces">;
      const looks: string[][] = [];
      let count = 0;
      let after: string | undefined = undefined;
      let next: string | null = "";
      do {
        const page = await convex.query(api.functions.noteIds.sharedIdReport, { workspaceId: id, after });
        for (const group of page.groups) {
          count += group.rows.length;
          if (group.needsLook) looks.push(group.rows.map((row) => row.path));
        }
        next = page.next;
        after = page.next ?? undefined;
      } while (next !== null);
      setFound({ count, looks });
    } catch (caught) {
      setSaid(messageFor(caught, "That didn't work. Try again."));
    } finally {
      setChecking(false);
    }
  }

  async function fix() {
    setFixing(true);
    setSaid(null);
    try {
      await repair({ workspaceId: workspaceId as Id<"workspaces"> });
      setSaid("Fixing. Check again in a minute to see what is left.");
    } catch (caught) {
      setSaid(messageFor(caught, "That didn't work. Try again."));
    } finally {
      setFixing(false);
    }
  }

  return (
    <View style={styles.shared} testID={`admin-noteids-shared-${workspaceId}`}>
      <View style={styles.actions}>
        {found === null ? null : (
          <Text variant="meta" testID={`admin-noteids-shared-count-${workspaceId}`}>
            {sharedIdsLine(found.count)}
          </Text>
        )}
        {found === null || found.count === 0 ? null : (
          <Button
            label={fixing ? "Fixing…" : "Fix"}
            disabled={fixing || checking}
            onPress={() => void fix()}
            testID={`admin-noteids-shared-fix-${workspaceId}`}
          />
        )}
        <Button
          label={checking ? "Checking…" : found === null ? "Check for shared ids" : "Check again"}
          disabled={checking || fixing}
          onPress={() => void check()}
          testID={`admin-noteids-shared-check-${workspaceId}`}
        />
      </View>
      {found?.looks.map((paths) => {
        const lines = needsLookLines(paths);
        return (
          <View key={paths.join("\n")} style={styles.look}>
            <Text variant="meta" style={styles.bad}>
              {lines.heading}
            </Text>
            {lines.paths.map((path) => (
              <Text key={path} variant="meta" numberOfLines={2}>
                {path}
              </Text>
            ))}
          </View>
        );
      })}
      {said ? <Text variant="meta">{said}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    shared: { flexBasis: "100%", gap: space.x2 },
    actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2 },
    look: { gap: 2, paddingLeft: space.x2 },
    bad: { color: colors.critText },
  });
