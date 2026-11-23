/**
 * "<Area> seat": the pop-up "Edit seat…" opens on an area. It edits the seat's
 * lines in its `about.md` (owner, helper, modes, metrics, approvals) and the
 * how-to-reach cards of the owner and the helper, and saves both in one go.
 * Credentials are never typed here: an agent's card names a vault item, and
 * the form has no field for a secret.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button } from "../../../../design/components/Button";
import { Icon } from "../../../../design/components/Icon";
import { TextField } from "../../../../design/components/Input";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { Chip, ReachFields } from "./ReachFields";
import { MODES, MODE_TIPS, type Card, type Mode, type Seat, type SeatEdit } from "./seat";

export interface SeatDialogProps {
  seat: Seat;
  /** The holder's card for the current owner / helper, looked up by the parent; called again when the owner field changes. */
  cardFor: (holder: string, kind: Card["kind"]) => Card;
  /** Whether an owner word is an agent (decides which card fields to show). */
  isAgent: (owner: string) => boolean;
  /** Owners to offer as quick chips (people and agents in use in the workspace); a text field also allows typing one. */
  suggestions: readonly string[];
  label: (owner: string) => string;
  /** false: everything read-only, no Save. */
  canEdit: boolean;
  /** Resolves a problem sentence, or null when saved. */
  onSave: (edit: SeatEdit, cards: readonly Card[]) => Promise<string | null>;
  onClose: () => void;
  /** "metric" opens with an empty metric row ready, as "Add a metric…" in the seat menu asks. */
  start?: "metric";
}

interface MetricRow {
  readonly id: number;
  readonly name: string;
  readonly target: string;
}

interface ApprovalRow {
  readonly id: number;
  readonly text: string;
}

interface DocumentLike {
  addEventListener(type: "keydown", listener: (event: { key: string }) => void): void;
  removeEventListener(type: "keydown", listener: (event: { key: string }) => void): void;
}

export function SeatDialog({ seat, cardFor, isAgent, suggestions, label, canEdit, onSave, onClose, start }: SeatDialogProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const ids = useRef(0);
  const nextId = () => {
    ids.current += 1;
    return ids.current;
  };

  const kindOf = (word: string): Card["kind"] => (isAgent(word) ? "agent" : "person");
  const ownerCardFor = (word: string): Card | null => {
    const holder = word.trim();
    return holder === "" ? null : cardFor(holder, kindOf(holder));
  };
  const helperCardFor = (word: string): Card | null => {
    const holder = word.trim();
    return holder === "" ? null : cardFor(holder, "agent");
  };

  // The owner field holds the seat's own owner, so an inherited one is shown as
  // a hint and saving without touching it leaves the inheritance as it was.
  const [owner, setOwner] = useState(seat.ownOwner ?? "");
  const [ownerCard, setOwnerCard] = useState<Card | null>(() => ownerCardFor(seat.ownOwner ?? ""));
  const [helper, setHelper] = useState(seat.helper ?? "");
  const [helperCard, setHelperCard] = useState<Card | null>(() => helperCardFor(seat.helper ?? ""));
  const [modes, setModes] = useState<readonly Mode[]>(seat.modes);
  const [metrics, setMetrics] = useState<readonly MetricRow[]>(() => [
    ...seat.metrics.map((metric) => ({ id: nextId(), name: metric.name, target: metric.target ?? "" })),
    ...(start === "metric" && canEdit ? [{ id: nextId(), name: "", target: "" }] : []),
  ]);
  const [approvals, setApprovals] = useState<readonly ApprovalRow[]>(() =>
    seat.approvals.map((text) => ({ id: nextId(), text })),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const doc = (globalThis as unknown as { document?: DocumentLike }).document;
    if (doc === undefined) return;
    const onKey = (event: { key: string }) => {
      if (event.key === "Escape") onClose();
    };
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ownerWord = owner.trim();
  const helperWord = helper.trim();
  const agentSuggestions = suggestions.filter((word) => isAgent(word));

  const changeOwner = (word: string) => {
    setOwner(word);
    setOwnerCard(ownerCardFor(word));
  };
  const changeHelper = (word: string) => {
    setHelper(word);
    setHelperCard(helperCardFor(word));
  };
  const patchOwner = (patch: Partial<Card>) => setOwnerCard((now) => (now === null ? now : { ...now, ...patch }));
  const patchHelper = (patch: Partial<Card>) => setHelperCard((now) => (now === null ? now : { ...now, ...patch }));
  const toggleMode = (mode: Mode) =>
    setModes((now) => (now.includes(mode) ? now.filter((each) => each !== mode) : [...now, mode]));
  const setMetric = (id: number, patch: Partial<Omit<MetricRow, "id">>) =>
    setMetrics((now) => now.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const setApproval = (id: number, text: string) =>
    setApprovals((now) => now.map((row) => (row.id === id ? { ...row, text } : row)));

  const save = async () => {
    if (busy) return;
    const cards: Card[] = [];
    if (ownerCard !== null && ownerWord !== "") cards.push({ ...ownerCard, kind: kindOf(ownerWord) });
    if (helperCard !== null && helperWord !== "") cards.push({ ...helperCard, kind: "agent" });
    const edit: SeatEdit = {
      owner: ownerWord === "" ? null : ownerWord,
      helper: helperWord === "" ? null : helperWord,
      modes,
      metrics: metrics.map((row) => ({ name: row.name.trim(), target: row.target.trim() === "" ? null : row.target.trim() })),
      approvals: approvals.map((row) => row.text.trim()).filter((text) => text !== ""),
    };
    setBusy(true);
    setProblem(null);
    const answer = await onSave(edit, cards);
    setBusy(false);
    if (answer === null) onClose();
    else setProblem(answer);
  };

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}} accessibilityLabel="Seat" testID="seat-dialog">
          <View style={styles.titleRow}>
            <Text variant="paneTitle" role="heading" aria-level={2}>
              {`${seat.name} seat`}
            </Text>
            <Pressable role="button" accessibilityLabel="Close" onPress={onClose} hitSlop={8}>
              <Icon name="close" size={14} color={colors.muted} />
            </Pressable>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
            <Block title="Owner" hint={seat.ownerFrom === null ? undefined : `Follows ${lastSegment(seat.ownerFrom)}`}>
              <View style={styles.chips} role="radiogroup" aria-label="Owner">
                <Chip label="No owner" on={ownerWord === ""} disabled={!canEdit} onPress={() => changeOwner("")} />
                {suggestions.map((word) => (
                  <Chip
                    key={word}
                    label={label(word)}
                    on={ownerWord === word}
                    disabled={!canEdit}
                    onPress={() => changeOwner(word)}
                  />
                ))}
              </View>
              <TextField
                label="Another owner"
                value={owner}
                onChangeText={changeOwner}
                placeholder="@handle or an agent name"
                autoCapitalize="none"
                autoCorrect={false}
                editable={canEdit}
                testID="seat-owner-input"
              />
            </Block>

            {ownerCard === null ? null : (
              <Block title={`How to reach ${label(ownerWord)}`}>
                <ReachFields
                  key={`owner:${ownerCard.holder}:${kindOf(ownerWord)}`}
                  card={ownerCard}
                  kind={kindOf(ownerWord)}
                  holderName={label(ownerWord)}
                  idPrefix="seat"
                  canEdit={canEdit}
                  onChange={patchOwner}
                />
              </Block>
            )}

            <Block title="Helper">
              <View style={styles.chips} role="radiogroup" aria-label="Helper">
                <Chip label="None" on={helperWord === ""} disabled={!canEdit} onPress={() => changeHelper("")} />
                {agentSuggestions.map((word) => (
                  <Chip
                    key={word}
                    label={label(word)}
                    on={helperWord === word}
                    disabled={!canEdit}
                    onPress={() => changeHelper(word)}
                  />
                ))}
              </View>
              <TextField
                label="Another helper"
                value={helper}
                onChangeText={changeHelper}
                placeholder="An agent's name"
                autoCapitalize="none"
                autoCorrect={false}
                editable={canEdit}
                testID="seat-helper-input"
              />
              {helperCard === null ? null : (
                <Block title={`How to reach ${label(helperWord)}`}>
                  <ReachFields
                    key={`helper:${helperCard.holder}`}
                    card={helperCard}
                    kind="agent"
                    holderName={label(helperWord)}
                    idPrefix="seat-helper"
                    canEdit={canEdit}
                    onChange={patchHelper}
                  />
                </Block>
              )}
            </Block>

            <Block title="Modes" hint="Labels, not rules. With no Manager the chart flags a gap.">
              <View style={styles.chips}>
                {MODES.map((mode) => (
                  <Chip
                    key={mode}
                    role="checkbox"
                    label={mode}
                    on={modes.includes(mode)}
                    hint={MODE_TIPS[mode]}
                    disabled={!canEdit}
                    onPress={() => toggleMode(mode)}
                  />
                ))}
              </View>
            </Block>

            <Block title="Metrics" hint="Readings go in this area's metrics.csv.">
              {metrics.map((row) => (
                <View key={row.id} style={styles.row}>
                  <TextField
                    label="Metric name"
                    labelHidden
                    placeholder="Metric"
                    value={row.name}
                    onChangeText={(name) => setMetric(row.id, { name })}
                    editable={canEdit}
                    containerStyle={styles.grow}
                  />
                  <TextField
                    label="Target"
                    labelHidden
                    placeholder="target, e.g. 2 days"
                    value={row.target}
                    onChangeText={(target) => setMetric(row.id, { target })}
                    editable={canEdit}
                    containerStyle={styles.target}
                  />
                  {canEdit ? (
                    <Remove label="Remove metric" onPress={() => setMetrics((now) => now.filter((each) => each.id !== row.id))} />
                  ) : null}
                </View>
              ))}
              {canEdit ? (
                <Button
                  label="+ Add metric"
                  variant="dialog"
                  onPress={() => {
                    const id = nextId();
                    setMetrics((now) => [...now, { id, name: "", target: "" }]);
                  }}
                  testID="seat-add-metric"
                />
              ) : null}
            </Block>

            <Block title="Needs approval" hint="Agents read these before they act.">
              {approvals.map((row) => (
                <View key={row.id} style={styles.row}>
                  <TextField
                    label="Approval rule"
                    labelHidden
                    placeholder="e.g. Spending over $20 needs the owner's approval."
                    value={row.text}
                    onChangeText={(text) => setApproval(row.id, text)}
                    editable={canEdit}
                    containerStyle={styles.grow}
                  />
                  {canEdit ? (
                    <Remove
                      label="Remove rule"
                      onPress={() => setApprovals((now) => now.filter((each) => each.id !== row.id))}
                    />
                  ) : null}
                </View>
              ))}
              {canEdit ? (
                <Button
                  label="+ Add a rule"
                  variant="dialog"
                  onPress={() => {
                    const id = nextId();
                    setApprovals((now) => [...now, { id, text: "" }]);
                  }}
                  testID="seat-add-rule"
                />
              ) : null}
            </Block>
          </ScrollView>

          <View style={styles.footer}>
            {problem === null ? null : (
              <Text variant="error" role="alert" testID="seat-problem">
                {problem}
              </Text>
            )}
            <Text variant="foot" testID="seat-saves-to">
              {`Written to ${seat.about.target}`}
            </Text>
            <View style={styles.actions}>
              <Button label={canEdit ? "Cancel" : "Close"} variant="dialog" onPress={onClose} />
              {canEdit ? (
                <Button
                  label={busy ? "Saving…" : "Save"}
                  variant="dialogPrimary"
                  disabled={busy}
                  onPress={() => void save()}
                  testID="seat-save"
                />
              ) : null}
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** One titled part of the form, with its hint under it. */
function Block({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.block}>
      <Text variant="eyebrow">{title}</Text>
      {children}
      {hint === undefined ? null : <Text variant="hint">{hint}</Text>}
    </View>
  );
}

/** The trailing × on a metric or rule row. */
function Remove({ label, onPress }: { label: string; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable role="button" accessibilityLabel={label} onPress={onPress} hitSlop={8}>
      <Icon name="close" size={14} color={colors.muted} />
    </Pressable>
  );
}

function lastSegment(folder: string): string {
  return folder.slice(folder.lastIndexOf("/") + 1);
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: { flex: 1, backgroundColor: "rgba(3,3,4,.72)", alignItems: "center", justifyContent: "center", padding: 24 },
    card: {
      width: "100%",
      maxWidth: 440,
      maxHeight: "90%",
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: 20,
      paddingHorizontal: 20,
      gap: space.x3,
      boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
    },
    titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    scroll: { flexGrow: 0 },
    body: { gap: space.x4 },
    block: { gap: space.x2 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    row: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    grow: { flex: 1, minWidth: 0 },
    target: { width: 130 },
    footer: { gap: space.x2 },
    actions: { flexDirection: "row", gap: 10, justifyContent: "flex-end" },
  });
