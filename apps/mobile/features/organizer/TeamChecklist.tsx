import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { TextLink } from "../design/components/TextLink";
import { radii, space } from "../design/tokens";
import { type Colors, useColors, useThemedStyles } from "../design/theme";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { sourceLine } from "./changeCopy";
import { gist, LEFT_OUT_WHY, teamsCopy } from "./teamCopy";
import type { RouteCard } from "./types";

/**
 * "For your teams" as one list to read and tick: board 9 of the What changed
 * canvas, drawn after Dev2's "I can't see what notes or the gist ... I can't
 * even see the original source material ... there's not an accept all button"
 * (2026-10-06).
 *
 * Every row says which team and folder, the note's gist, where it came from
 * (the email's thread by name) and what was kept back, by name. Everything
 * starts ticked; one button adds the ticked ones, and says how many go to
 * which team. Show original puts the arrival's own lines on the row, the ones
 * the note used marked and the ones held back struck, each with why: only the
 * owner ever sees this, as only they can open the original. Edit the note
 * opens it exactly as the team would read it.
 */
export function TeamChecklist({
  routes,
  busy,
  touch,
  onAdd,
  onEdit,
  onKeep,
  onSkip,
  onOpenSource,
}: {
  routes: readonly RouteCard[];
  busy: ReadonlySet<string>;
  touch: boolean;
  onAdd: (cards: readonly RouteCard[]) => Promise<unknown>;
  onEdit: (card: RouteCard) => void;
  onKeep: (card: RouteCard) => void;
  onSkip: (cards: readonly RouteCard[]) => void;
  onOpenSource?: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  // Unticked, not ticked: a note that arrives while the page is open starts ticked like the rest.
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [team, setTeam] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(0);
  if (routes.length === 0) return null;

  const teams = [...new Set(routes.map((card) => card.team))];
  const filter = team !== null && teams.includes(team) ? team : null;
  const shown = filter === null ? routes : routes.filter((card) => card.team === filter);
  const ticked = shown.filter((card) => !off.has(card.id));
  const unticked = shown.filter((card) => off.has(card.id));
  const working = adding > 0 || shown.some((card) => busy.has(card.id));

  const flip = (ids: readonly string[], on: boolean) =>
    setOff((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  const add = () => {
    const cards = ticked;
    setAdding(cards.length);
    void onAdd(cards).finally(() => setAdding(0));
  };

  return (
    <View testID="team-notes" style={styles.list}>
      <View style={[styles.bar, touch && styles.barTouch]} testID="team-bar">
        <View style={styles.barLeft}>
          <Tick
            on={ticked.length > 0 && unticked.length === 0}
            mixed={ticked.length > 0 && unticked.length > 0}
            label={teamsCopy.tickedOf(ticked.length, shown.length)}
            disabled={working}
            onToggle={() => flip(shown.map((card) => card.id), ticked.length === 0)}
            testID="team-tick-all"
          />
          {teams.length > 1 ? (
            <View style={styles.filters}>
              <Filter label={teamsCopy.all(routes.length)} on={filter === null} onPress={() => setTeam(null)} testID="team-filter-all" />
              {teams.map((name) => (
                <Filter
                  key={name}
                  label={`${name} ${routes.filter((card) => card.team === name).length}`}
                  on={filter === name}
                  onPress={() => setTeam(name)}
                  testID={`team-filter-${name.slice(1)}`}
                />
              ))}
            </View>
          ) : null}
        </View>
        <View style={styles.acts}>
          {unticked.length > 0 ? (
            <Button
              label={teamsCopy.skipRest}
              onPress={() => onSkip(unticked)}
              disabled={working}
              variant="dialog"
              testID="team-skip-rest"
            />
          ) : null}
          <Button
            // A phone's bar is too narrow for where each note goes; the team filters above it say.
            label={adding > 0 ? teamsCopy.adding(adding) : touch ? teamsCopy.addTickedShort(ticked.length) : teamsCopy.addTicked(ticked)}
            accessibilityLabel={adding > 0 ? undefined : teamsCopy.addTicked(ticked)}
            onPress={add}
            disabled={working || ticked.length === 0}
            variant="dialogPrimary"
            testID="team-add-ticked"
          />
        </View>
      </View>

      {shown.map((card) => (
        <TeamRow
          key={card.id}
          card={card}
          on={!off.has(card.id)}
          open={open.has(card.id)}
          pending={busy.has(card.id)}
          touch={touch}
          onToggle={() => flip([card.id], off.has(card.id))}
          onShow={(show) =>
            setOpen((current) => {
              const next = new Set(current);
              if (show) next.add(card.id);
              else next.delete(card.id);
              return next;
            })
          }
          onEdit={() => onEdit(card)}
          onKeep={() => onKeep(card)}
          onOpenSource={onOpenSource}
        />
      ))}
    </View>
  );
}

function TeamRow({
  card,
  on,
  open,
  pending,
  touch,
  onToggle,
  onShow,
  onEdit,
  onKeep,
  onOpenSource,
}: {
  card: RouteCard;
  on: boolean;
  open: boolean;
  pending: boolean;
  touch: boolean;
  onToggle: () => void;
  onShow: (show: boolean) => void;
  onEdit: () => void;
  onKeep: () => void;
  onOpenSource?: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const from = sourceLine(card.source) + (card.source.subject ? ` · “${isolateForDisplay(card.source.subject)}”` : "");
  return (
    <View
      style={[styles.row, touch && styles.rowTouch, open && styles.rowOpen, !on && styles.rowOff]}
      role="group"
      aria-label={card.title}
      testID={`team-note-${card.id}`}
    >
      <View style={styles.rowHead}>
        <Tick on={on} label={card.title} hideLabel disabled={pending} onToggle={onToggle} testID={`team-tick-${card.id}`} />
        <View style={styles.rowText}>
          <View style={[styles.titleLine, touch && styles.titleLineTouch]}>
            <Text variant="rowTitle" role="heading" aria-level={2} style={styles.title}>
              {isolateForDisplay(card.title)}
            </Text>
            <Text variant="treeMeta" style={styles.where}>
              {teamsCopy.where(card)}
            </Text>
          </View>
          <Text variant="rowSub" numberOfLines={open ? undefined : 2} style={styles.gist} testID={`team-note-gist-${card.id}`}>
            {gist(card.body)}
          </Text>
          <View style={styles.meta}>
            <Text variant="treeMeta" style={styles.muted}>
              {`${from} ·`}
            </Text>
            {open ? null : (
              <>
                <TextLink label={teamsCopy.showOriginal} onPress={() => onShow(true)} testID={`team-note-show-${card.id}`} />
                <Text variant="treeMeta" style={styles.muted}>
                  ·
                </Text>
              </>
            )}
            <Text variant="treeMeta" style={styles.muted} testID={`team-note-left-out-${card.id}`}>
              {teamsCopy.keptBack(card.leftOut)}
            </Text>
          </View>
        </View>
      </View>
      {open ? (
        <View style={[styles.split, touch && styles.splitTouch]}>
          <Original card={card} onOpenSource={onOpenSource} />
          <View style={[styles.gets, !touch && styles.getsWide]}>
            <Text variant="rowTitle">{teamsCopy.teamGets(card.team)}</Text>
            <Text variant="treeMeta" style={styles.muted}>
              {card.uses.length > 0 ? teamsCopy.teamGetsLede : teamsCopy.teamGetsLedeNoLines}
            </Text>
            <View style={styles.links}>
              <TextLink label={teamsCopy.editNote} onPress={onEdit} disabled={pending} testID={`team-note-edit-${card.id}`} />
              <TextLink
                label={teamsCopy.dontAdd}
                accessibilityLabel={`${teamsCopy.dontAdd}: ${card.title}`}
                onPress={onKeep}
                disabled={pending}
                testID={`team-note-keep-${card.id}`}
              />
              <TextLink label={teamsCopy.hideOriginal} onPress={() => onShow(false)} testID={`team-note-hide-${card.id}`} />
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** The arrival's own lines, as only its owner sees them: used ones marked, held-back ones struck. */
function Original({ card, onOpenSource }: { card: RouteCard; onOpenSource?: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.original} testID={`team-note-original-${card.id}`}>
      <View style={styles.originalHead}>
        <View style={styles.lockLine}>
          <Icon name="lock" size={12} color={colors.chromeMuted} />
          <Text variant="treeMeta" style={styles.muted}>
            {teamsCopy.originalHeading}
          </Text>
        </View>
        {onOpenSource ? (
          <TextLink
            label={teamsCopy.openSource(card.source.kind)}
            onPress={() => onOpenSource(card.source.path)}
            testID={`team-note-source-${card.id}`}
          />
        ) : null}
      </View>
      {card.uses.length === 0 ? (
        <Text variant="treeMeta" style={styles.muted}>
          {teamsCopy.noLines}
        </Text>
      ) : (
        card.uses.map((line, at) => (
          <Text key={`u${at}`} variant="rowSub" style={styles.used} testID={`team-note-use-${card.id}-${at}`}>
            {isolateForDisplay(line)}
          </Text>
        ))
      )}
      {card.leftOut.map((held, at) => (
        <View key={`h${at}`} style={styles.held} testID={`team-note-held-${card.id}-${at}`}>
          {held.quote ? (
            <Text variant="rowSub" style={styles.struck}>
              {isolateForDisplay(held.quote)}
            </Text>
          ) : null}
          <View style={styles.why}>
            <Text variant="treeMeta" style={styles.whyText}>
              {`Kept back: ${isolateForDisplay(held.what)}`}
            </Text>
          </View>
          <Text variant="treeMeta" style={styles.muted}>
            {LEFT_OUT_WHY[held.why]}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Tick({
  on,
  mixed = false,
  label,
  hideLabel = false,
  disabled,
  onToggle,
  testID,
}: {
  on: boolean;
  mixed?: boolean;
  label: string;
  hideLabel?: boolean;
  disabled: boolean;
  onToggle: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable
      role="checkbox"
      aria-checked={mixed ? "mixed" : on}
      accessibilityState={{ checked: mixed ? "mixed" : on, disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onToggle}
      style={styles.tickPress}
      testID={testID}
    >
      <View style={[styles.tick, (on || mixed) && styles.tickOn]} aria-hidden>
        {on ? <Icon name="check" size={11} color={colors.ground} /> : mixed ? <View style={styles.dash} /> : null}
      </View>
      {hideLabel ? null : (
        <Text variant="rowTitle" style={styles.tickLabel}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

function Filter({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable role="button" aria-pressed={on} onPress={onPress} style={[styles.filter, on && styles.filterOn]} testID={testID}>
      <Text variant="treeMeta" style={on ? styles.filterOnText : styles.filterText}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    list: { gap: space.x3 },
    bar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      flexWrap: "wrap",
      gap: space.x3,
      paddingVertical: space.x3,
      paddingHorizontal: space.x4,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    barTouch: { flexDirection: "column", alignItems: "stretch" },
    barLeft: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.x3 },
    filters: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    filter: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.line },
    filterOn: { backgroundColor: colors.text, borderColor: colors.text },
    filterText: { color: colors.text },
    filterOnText: { color: colors.ground },
    acts: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.x2 },
    row: {
      gap: space.x3,
      paddingVertical: space.x4,
      paddingHorizontal: space.x5,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    rowTouch: { paddingHorizontal: space.x4 },
    rowOpen: { backgroundColor: colors.surface, borderColor: colors.lineStrong },
    rowOff: { borderStyle: "dashed" },
    rowHead: { flexDirection: "row", alignItems: "flex-start", gap: space.x3 },
    rowText: { flex: 1, minWidth: 0, gap: space.x1 },
    titleLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: space.x3 },
    titleLineTouch: { flexDirection: "column", alignItems: "flex-start", gap: 2 },
    title: { color: colors.text, flexShrink: 1 },
    where: { color: colors.accentText, fontWeight: "600" },
    gist: { color: colors.text2 },
    meta: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", columnGap: space.x2, rowGap: 2 },
    muted: { color: colors.chromeMuted },
    split: { flexDirection: "row", alignItems: "flex-start", gap: space.x4 },
    splitTouch: { flexDirection: "column", alignItems: "stretch" },
    original: { flex: 1, minWidth: 0, gap: space.x3, padding: space.x4, borderRadius: radii.md, backgroundColor: colors.surface2 },
    originalHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: space.x2 },
    lockLine: { flexDirection: "row", alignItems: "center", gap: 6 },
    used: { color: colors.text, backgroundColor: colors.accentDim, alignSelf: "flex-start", paddingHorizontal: 3, borderRadius: 3 },
    held: { gap: 2 },
    struck: { color: colors.chromeMuted, textDecorationLine: "line-through" },
    why: { alignSelf: "flex-start", paddingVertical: 1, paddingHorizontal: 8, borderRadius: radii.pill, backgroundColor: colors.chipFill },
    whyText: { color: colors.text2, fontWeight: "600" },
    gets: { gap: space.x2 },
    getsWide: { width: 260 },
    links: { alignItems: "flex-start", gap: space.x2, marginTop: space.x2 },
    tickPress: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    // `ToggleGroup`'s box (design/components/Input.tsx), the same tick the change cards' steps use.
    tick: {
      width: 18,
      height: 18,
      marginTop: 2,
      borderRadius: 5,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    tickOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    dash: { width: 8, height: 2, borderRadius: 1, backgroundColor: colors.ground },
    tickLabel: { color: colors.text },
  });
