import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { TextField } from "../design/components/Input";
import { Switch } from "../design/components/Switch";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { type Colors, useThemedStyles } from "../design/theme";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { LEFT_OUT_WHY, teamsCopy } from "./teamCopy";
import type { RouteCard, RouteTeam } from "./types";

/**
 * "For your teams": boards 6–7 of the What changed canvas. The list itself is
 * `TeamChecklist` (board 9); Edit the note opens the note here exactly as the
 * team would read it, editable, beside what was left out and why.
 */
/** Board 6: the note exactly as the team will read it, editable, before it goes. */
export function TeamNotePreview({
  card,
  pending,
  touch,
  onCancel,
  onSend,
}: {
  card: RouteCard;
  pending: boolean;
  touch: boolean;
  onCancel: () => void;
  onSend: (title: string, body: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const ready = title.trim().length >= 3 && body.trim().length > 0;
  return (
    <View style={styles.preview} testID="team-note-preview">
      <View style={[styles.head, touch && styles.headTouch]}>
        <View style={styles.headText}>
          <Text variant="paneTitle" role="heading" aria-level={1}>
            {teamsCopy.preview(card.team)}
          </Text>
          <Text variant="hint" style={styles.muted}>
            {teamsCopy.previewLede}
          </Text>
        </View>
        <View style={styles.acts}>
          <Button label={teamsCopy.cancel} onPress={onCancel} variant="dialog" testID="team-note-cancel" />
          <Button
            label={pending ? teamsCopy.sending : teamsCopy.add(card.team)}
            onPress={() => onSend(title.trim(), body.trim())}
            disabled={pending || !ready}
            variant="dialogPrimary"
            testID="team-note-send"
          />
        </View>
      </View>
      <View style={styles.columns}>
        <View style={styles.sheet}>
          <Text variant="treeMeta" style={styles.muted} testID="team-note-goes-in">
            {teamsCopy.goesIn(card)}
          </Text>
          <TextField label={teamsCopy.titleLabel} value={title} onChangeText={setTitle} maxLength={100} testID="team-note-title" />
          <TextField
            label={teamsCopy.bodyLabel}
            value={body}
            onChangeText={setBody}
            multiline
            maxLength={1500}
            style={styles.body}
            testID="team-note-body"
          />
          <Text variant="treeMeta" style={styles.muted}>
            {teamsCopy.footer(card.source.kind)}
          </Text>
        </View>
        <View style={[styles.aside, touch && styles.asideTouch]}>
          <View style={[styles.panel, !touch && styles.asidePanel]} testID="team-note-left-out">
            <Text variant="rowTitle">{teamsCopy.leftOutHeading}</Text>
            {card.leftOut.length === 0 ? (
              <Text variant="treeMeta" style={styles.muted}>
                {teamsCopy.nothingLeftOut}
              </Text>
            ) : (
              card.leftOut.map((held, at) => (
                <View key={at} style={[styles.heldRow, at === card.leftOut.length - 1 && styles.heldLast]}>
                  <Text variant="body">{isolateForDisplay(held.what)}</Text>
                  <Text variant="treeMeta" style={styles.muted}>
                    {LEFT_OUT_WHY[held.why]}
                  </Text>
                </View>
              ))
            )}
          </View>
          <View style={[styles.panel, !touch && styles.asidePanel]}>
            <Text variant="rowTitle">{teamsCopy.canGoHeading}</Text>
            <Text variant="treeMeta" style={styles.muted}>
              {teamsCopy.canGo}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

/** Board 7, on the page: which teams get notes, and what the owner keeps back. */
export function TeamSettings({
  teams,
  keep,
  onToggle,
  onKeep,
}: {
  teams: readonly RouteTeam[];
  keep: string;
  onToggle: (team: string, on: boolean) => void;
  onKeep: (keep: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [draft, setDraft] = useState(keep);
  useEffect(() => setDraft(keep), [keep]);
  if (teams.length === 0) return null;
  const changed = draft.trim() !== keep.trim();
  return (
    <View style={styles.settings} testID="team-settings">
      <Text variant="rowTitle" role="heading" aria-level={2}>
        {teamsCopy.settingsHeading}
      </Text>
      <Text variant="treeMeta" style={styles.muted}>
        {teamsCopy.settingsLede}
      </Text>
      <View style={styles.panel}>
        {teams.map((team, at) => (
          <View key={team.name} style={[styles.teamRow, at === teams.length - 1 && styles.heldLast]}>
            <View style={styles.grow}>
              <Text variant="rowTitle">{team.name}</Text>
              <Text variant="treeMeta" style={styles.muted}>
                {isolateForDisplay(team.title)}
              </Text>
            </View>
            <Switch value={team.on} onValueChange={(on) => onToggle(team.name, on)} label={teamsCopy.teamSwitch(team.name)} testID={`team-switch-${team.name.slice(1)}`} />
          </View>
        ))}
      </View>
      <TextField
        label={teamsCopy.keepLabel}
        hint={teamsCopy.keepHint}
        value={draft}
        onChangeText={setDraft}
        placeholder={teamsCopy.keepPlaceholder}
        maxLength={300}
        multiline
        testID="team-keep"
      />
      <View style={styles.acts}>
        <Button
          label={changed ? teamsCopy.save : teamsCopy.saved}
          onPress={() => onKeep(draft.trim())}
          disabled={!changed}
          variant="dialog"
          testID="team-keep-save"
        />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.x4, flexWrap: "wrap" },
    headTouch: { flexDirection: "column", alignItems: "stretch" },
    headText: { flex: 1, minWidth: 200, gap: space.x1 },
    acts: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.x2 },
    muted: { color: colors.chromeMuted },
    preview: { paddingTop: space.x8, paddingBottom: space.x8, gap: space.x5 },
    // The note first, full width, then what was held back: the page column is
    // a note's width, too narrow to set the two side by side.
    columns: { gap: space.x5 },
    grow: { flex: 1, minWidth: 0 },
    sheet: {
      gap: space.x4,
      padding: space.x6,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    body: { minHeight: 180, textAlignVertical: "top" },
    aside: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: space.x4 },
    asideTouch: { flexDirection: "column", alignItems: "stretch" },
    panel: {
      gap: space.x2,
      padding: space.x5,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    asidePanel: { flexGrow: 1, flexBasis: 240 },
    heldRow: { gap: 2, paddingBottom: space.x3, borderBottomWidth: 1, borderBottomColor: colors.line },
    heldLast: { borderBottomWidth: 0, paddingBottom: 0 },
    settings: { gap: space.x3, marginTop: space.x6 },
    teamRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x4,
      paddingBottom: space.x3,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
  });
