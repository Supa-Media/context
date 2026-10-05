import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { TextField } from "../design/components/Input";
import { Switch } from "../design/components/Switch";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { type Colors, useColors, useThemedStyles } from "../design/theme";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { sourceLine } from "./changeCopy";
import { LEFT_OUT_WHY, teamsCopy } from "./teamCopy";
import type { RouteCard, RouteTeam } from "./types";

/**
 * "For your teams": boards 5–7 of the What changed canvas, drawn on a
 * personal workspace's What changed page.
 *
 * A card says which team, the new note's headline and where it would go, the
 * meeting or email it came from (a link only its owner can follow), and how
 * much was held back. Add opens the note exactly as the team would read it,
 * editable, beside what was left out and why; only Add there sends it.
 */
export function TeamCards({
  routes,
  busy,
  touch,
  onPreview,
  onKeep,
  onOpenSource,
}: {
  routes: readonly RouteCard[];
  busy: ReadonlySet<string>;
  touch: boolean;
  onPreview: (card: RouteCard) => void;
  onKeep: (card: RouteCard) => void;
  onOpenSource?: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  if (routes.length === 0) return null;
  return (
    <View testID="team-notes">
      {routes.map((card) => {
        const pending = busy.has(card.id);
        const source = sourceLine(card.source);
        return (
          <View key={card.id} style={[styles.card, touch && styles.cardTouch]} role="group" aria-label={card.title} testID={`team-note-${card.id}`}>
            <View style={[styles.head, touch && styles.headTouch]}>
              <View style={styles.headText}>
                <Text variant="eyebrow" style={styles.team}>
                  {teamsCopy.forTeam(card.team)}
                </Text>
                <Text variant="noteTitle" role="heading" aria-level={2} style={styles.headline}>
                  {isolateForDisplay(card.title)}
                </Text>
              </View>
              <View style={styles.acts}>
                <Button
                  label={teamsCopy.keep}
                  accessibilityLabel={`${teamsCopy.keep}: ${card.title}`}
                  onPress={() => onKeep(card)}
                  disabled={pending}
                  variant="dialog"
                  testID={`team-note-keep-${card.id}`}
                />
                <Button
                  label={teamsCopy.add(card.team)}
                  onPress={() => onPreview(card)}
                  disabled={pending}
                  variant="dialogPrimary"
                  testID={`team-note-add-${card.id}`}
                />
              </View>
            </View>
            <Text variant="treeMeta" style={styles.muted}>
              {`${teamsCopy.newNote} · ${teamsCopy.inFolder(card)}`}
            </Text>
            <View style={styles.sourceRow}>
              {onOpenSource ? (
                <PressRow
                  role="link"
                  accessibilityLabel={`${source}. Open it`}
                  onPress={() => onOpenSource(card.source.path)}
                  radius={radii.pill}
                  style={styles.chip}
                  hoverStyle={styles.chipHover}
                  testID={`team-note-source-${card.id}`}
                >
                  <Icon name="lock" size={12} color={colors.text2} />
                  <Text variant="treeMeta" numberOfLines={1} style={styles.chipText}>
                    {source}
                  </Text>
                </PressRow>
              ) : null}
              <Text variant="treeMeta" style={styles.muted}>
                {teamsCopy.stays}
              </Text>
            </View>
            {card.leftOut.length > 0 ? (
              <Text variant="treeMeta" style={styles.muted} testID={`team-note-left-out-${card.id}`}>
                {teamsCopy.leftOut(card.leftOut.length)}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

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
    card: {
      gap: space.x3,
      padding: space.x6,
      marginBottom: space.x4,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    cardTouch: { padding: space.x4 },
    head: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.x4, flexWrap: "wrap" },
    headTouch: { flexDirection: "column", alignItems: "stretch" },
    headText: { flex: 1, minWidth: 200, gap: space.x1 },
    team: { color: colors.accent },
    headline: { color: colors.text },
    acts: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.x2 },
    muted: { color: colors.chromeMuted },
    sourceRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.x2 },
    chip: {
      alignSelf: "flex-start",
      maxWidth: "100%",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 5,
      paddingHorizontal: 10,
      borderRadius: radii.pill,
      backgroundColor: colors.chipFill,
    },
    chipHover: { backgroundColor: colors.surface3 },
    chipText: { color: colors.text2, flexShrink: 1 },
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
