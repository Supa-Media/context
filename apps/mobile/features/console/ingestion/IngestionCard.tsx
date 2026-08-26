import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { ConvexError } from "convex/values";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { CopyField } from "../../design/components/CopyField";
import { Field } from "../../design/components/Field";
import { ChoiceGroup, FormError, Notice, TextField } from "../../design/components/Input";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { colors } from "../../design/tokens";
import { useCopy } from "../../design/useCopy";
import {
  addSender,
  describeDraftProblem,
  describeSenderPolicy,
  diff,
  draftOf,
  isDirty,
  isSenderProblem,
  normaliseFolder,
  receivesMail,
  removeSender,
  senderEntries,
  senderLabel,
  type IngestionDraft,
  type IngestionState,
  type SenderEntry,
} from "./settings";

/**
 * Email ingestion, in a context's settings.
 *
 * Two things used to be presented as fixed and are not: where forwarded mail
 * lands, and who is allowed to send it. The second is the one that matters.
 * The address is semi-public by nature — it ends up in a forwarding rule, a
 * mailing list, a screenshot — so **the allow-list is the security control**,
 * and "anyone" is something you turn on deliberately, with the consequence
 * written out, rather than the state you end up in by not deciding.
 *
 * The card is resilient to the backend not being there. `getIngestionSettings`
 * is being built in parallel; until a deployment has it, this shows the
 * derived address and says plainly that the rules are not configurable yet,
 * which is better than a form whose Save does nothing.
 *
 * ## Nothing here claims mail lands unless the control plane says it does
 *
 * There is no email receiver deployed, and this card used to describe one in
 * the present tense — "Forward any email here and it lands in 0-inbox/", next
 * to a Copy button. It was believed. The address bounced.
 *
 * So every sentence about delivery, and the Copy button that invites somebody
 * to go and use the address right now, are gated on `receivesMail(state)` —
 * read its doc comment. The address itself is still shown and still
 * selectable, because it is the real address and will work unchanged the day
 * the receiver ships; what is withheld is the claim and the invitation.
 *
 * The allow-list and target-folder controls are deliberately **not** gated.
 * They save real rows, they are the posture the receiver will enforce on its
 * very first message, and an owner who sets them up in advance has done
 * something useful. Only the claims about what happens to mail are held back.
 */
export function IngestionCard({
  state,
  fallbackAddress,
  /** Folders currently loaded in the tree, offered as one-tap targets. */
  folders,
}: {
  state: IngestionState;
  fallbackAddress: string;
  folders: readonly string[];
}) {
  const address = state.settings?.address ?? fallbackAddress;
  const copy = useCopy(address);

  const [draft, setDraft] = useState<IngestionDraft | null>(null);
  const [entry, setEntry] = useState("");
  const [entryProblem, setEntryProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-seed whenever the stored settings change under us — another console, or
  // the first load landing. An edit in progress is not clobbered silently: the
  // key is the stored value, so a save elsewhere replaces this draft, which is
  // the same "last write is the one you can see" the file editor uses.
  const seed = state.settings === null ? null : JSON.stringify(draftOf(state.settings));
  useEffect(() => {
    setDraft(seed === null ? null : (JSON.parse(seed) as IngestionDraft));
    setEntry("");
    setEntryProblem(null);
    setSaveError(null);
  }, [seed]);

  const saved = state.settings === null ? null : draftOf(state.settings);
  const canEdit = state.save !== undefined;
  // The one question this card must ask before saying anything about mail.
  const receiving = receivesMail(state);
  const shown = draft ?? saved;
  const policy = shown === null ? null : describeSenderPolicy(shown);
  const folderProblem = shown === null ? null : describeDraftProblem(shown);
  const dirty = draft !== null && saved !== null && isDirty(draft, saved);

  return (
    <Card>
      <Row>
        <Grow>
          <Text variant="rowTitle">Ingestion address</Text>
          {receiving ? (
            <Text variant="rowSub" style={styles.rowSub}>
              Forward any email here and it lands in{" "}
              <Text variant="mono" style={styles.inlineMono}>
                {shown?.targetFolder ?? "0-inbox/"}
              </Text>
            </Text>
          ) : (
            /*
              One sentence, not a hedge. "Not yet" plus what it means for the
              reader — mail sent today bounces — and nothing about folders,
              senders or acceptance, none of which happen to a message that is
              never delivered.
            */
            <Text variant="rowSub" style={styles.rowSub} testID="ingestion-not-receiving">
              This address is reserved for you, but nothing is receiving mail at it yet —
              anything sent to it today bounces.
            </Text>
          )}
        </Grow>
        {/*
          No Copy button until there is somewhere for the copied address to be
          pasted usefully. The address stays visible and selectable below, so
          nothing is hidden; what is withheld is the affordance that says "take
          this and go use it". Same rule as `StorageActions` and `save`: a
          control that is never offered cannot mislead.
        */}
        {receiving ? (
          <Button
            label={copy.label}
            accessibilityLabel="Copy your ingestion address"
            onPress={copy.copy}
          />
        ) : null}
      </Row>
      <CopyField value={address} copyable={false} style={styles.spaced} />

      {state.loading ? (
        <View style={[styles.loadingRow, styles.spaced]}>
          <ActivityIndicator color={colors.text2} size="small" />
          <Text variant="rowSub">Loading the ingestion rules…</Text>
        </View>
      ) : null}

      {/*
        This used to go on to promise that everything forwarded lands in
        `0-inbox/` and that any sender is accepted — two sentences describing a
        pipeline that has never run, on the one deployment that does not even
        have the settings module. Both are gone; what remains is the only thing
        this branch actually knows.
      */}
      {!state.available ? (
        <Notice style={styles.spaced}>
          <Text variant="check">
            This address is not configurable yet on this deployment.
          </Text>
        </Notice>
      ) : null}

      {/*
        `null` from `getIngestionSettings` is not "loading" and not "nearly
        configured" — the backend documents it as the fail-closed floor: no
        policy row at all. Said as what an owner has to *do*, not as what
        happens to mail in the meantime, because nothing happens to mail in the
        meantime either way.
      */}
      {state.available && !state.loading && shown === null ? (
        <Notice tone="warn" style={styles.spaced}>
          <Text variant="check" style={styles.warnText}>
            Ingestion is off for this context — an owner has to set a target folder and
            say who may send.
          </Text>
        </Notice>
      ) : null}

      {shown !== null ? (
        <View style={styles.settings}>
          {canEdit ? (
            <TextField
              label="Target folder"
              value={draft?.targetFolder ?? shown.targetFolder}
              onChangeText={(value) =>
                setDraft((current) => (current === null ? current : { ...current, targetFolder: value }))
              }
              onBlur={() =>
                setDraft((current) =>
                  current === null
                    ? current
                    : { ...current, targetFolder: normaliseFolder(current.targetFolder) },
                )
              }
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="0-inbox/"
              hint="Any folder in this context. It does not have to exist yet."
              error={folderProblem ?? undefined}
              testID="ingestion-folder"
            />
          ) : (
            <Field label="Target folder" value={shown.targetFolder} />
          )}

          {/*
            One-tap targets from the tree that is already loaded. The root is
            deliberately not offered: mail landing beside index.md and
            privacy.md is nobody's filing system.
          */}
          {canEdit && quickPicks(folders).length > 0 ? (
            <View style={styles.quickPicks}>
              {quickPicks(folders).map((folder) => (
                <Button
                  key={folder}
                  label={`${folder}/`}
                  accessibilityLabel={`Deliver mail to ${folder}`}
                  onPress={() =>
                    setDraft((current) =>
                      current === null ? current : { ...current, targetFolder: `${folder}/` },
                    )
                  }
                />
              ))}
            </View>
          ) : null}

          {canEdit ? (
            <ChoiceGroup
              label="Who may send to it"
              hint="Anyone who learns this address can try it. Only the senders below are allowed."
              value={shown.allowAnySender ? "anyone" : "list"}
              onChange={(value) =>
                setDraft((current) =>
                  current === null ? current : { ...current, allowAnySender: value === "anyone" },
                )
              }
              options={[
                {
                  value: "list",
                  label: "Only the senders I list",
                  detail: "Specific addresses, or whole domains. Nobody else.",
                },
                {
                  value: "anyone",
                  label: "Anyone",
                  detail:
                    "An open drop-box. Anyone who learns the address — a forwarded thread, a mailing list, a screenshot — can put a note in this context.",
                },
              ]}
              testID="ingestion-who"
            />
          ) : (
            <View style={styles.readOnlyBlock}>
              <Text variant="eyebrow">Who may send to it</Text>
              <Text variant="rowSub" style={styles.rowSub}>
                {shown.allowAnySender ? "Anyone" : "Only the senders listed below"}
              </Text>
            </View>
          )}

          {shown.allowAnySender ? (
            <Notice tone="warn">
              <Text variant="check" style={styles.warnText}>
                Nothing is checked. Anyone who learns this address is allowed to add notes
                to this context, and notes in this context are read by every AI client you
                have connected to it.
              </Text>
            </Notice>
          ) : (
            <View style={styles.senders}>
              <Text variant="eyebrow">Allowed senders</Text>
              <View style={styles.chips}>
                {senderEntries(shown).length === 0 ? (
                  <Text variant="rowSub">Nobody yet.</Text>
                ) : null}
                {senderEntries(shown).map((item) => (
                  <SenderChip
                    key={`${item.kind}:${item.value}`}
                    entry={item}
                    onRemove={
                      canEdit
                        ? () =>
                            setDraft((current) =>
                              current === null ? current : removeSender(current, item),
                            )
                        : undefined
                    }
                  />
                ))}
              </View>

              {canEdit ? (
                <View style={styles.addRow}>
                  <TextField
                    label="Add a sender"
                    value={entry}
                    onChangeText={(value) => {
                      setEntry(value);
                      setEntryProblem(null);
                    }}
                    onSubmitEditing={() => {
                      const result = addSender(draft ?? shown, entry);
                      if (isSenderProblem(result)) {
                        setEntryProblem(result.problem);
                        return;
                      }
                      setDraft(result.draft);
                      setEntry("");
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    inputMode="email"
                    placeholder="someone@example.com or example.com"
                    hint="A whole domain allows everyone with an address there."
                    error={entryProblem ?? undefined}
                    containerStyle={styles.addField}
                    testID="ingestion-add"
                  />
                  <Button
                    label="Add"
                    onPress={() => {
                      const result = addSender(draft ?? shown, entry);
                      if (isSenderProblem(result)) {
                        setEntryProblem(result.problem);
                        return;
                      }
                      setDraft(result.draft);
                      setEntry("");
                    }}
                    style={styles.addButton}
                  />
                </View>
              ) : null}
            </View>
          )}

          {/*
            One summary, not two. "Anyone" already has its own warning above
            with the consequence spelled out, and repeating a shorter version
            of it directly underneath reads as two different problems.
          */}
          {policy !== null && !shown.allowAnySender ? (
            <Notice tone={policy.tone === "crit" ? "warn" : policy.tone}>
              <Text
                variant="check"
                style={policy.tone === "ok" ? styles.okText : styles.warnText}
              >
                {policy.text}
              </Text>
            </Notice>
          ) : null}

          {saveError ? <FormError headline="That did not save." next={saveError} /> : null}

          {canEdit ? (
            <Row style={styles.actions}>
              <Button
                label={saving ? "Saving…" : "Save"}
                variant="white"
                disabled={!dirty || saving || folderProblem !== null}
                onPress={() => {
                  if (draft === null || saved === null || state.save === undefined) return;
                  setSaving(true);
                  setSaveError(null);
                  state
                    .save(diff(draft, saved))
                    // The backend refuses rather than repairs, and its
                    // `ConvexError` messages name the offending entry and are
                    // written to be shown. Replacing one with "try again"
                    // would hide the only thing that says what to fix.
                    .catch((error: unknown) => setSaveError(refusalMessage(error)))
                    .finally(() => setSaving(false));
                }}
                testID="ingestion-save"
              />
              <Button
                label="Revert"
                disabled={!dirty || saving}
                onPress={() => setDraft(saved)}
              />
            </Row>
          ) : (
            <Text variant="foot">
              Only an owner of this context can change where mail lands or who may send it.
            </Text>
          )}
        </View>
      ) : null}
    </Card>
  );
}

/**
 * What the control plane said, or a fixed sentence.
 *
 * Never the raw error text of an unknown failure — the same rule the file
 * editor's `toFileError` follows. A `ConvexError` payload is written for a
 * person; anything else is whatever the runtime produced, and putting that in
 * front of somebody is how a stack trace ends up in a screenshot.
 */
function refusalMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: unknown } | undefined;
    if (typeof data?.message === "string") return data.message;
  }
  return "The control plane refused the change. Try again.";
}

/** Top-level folders from the loaded tree, root excluded. */
function quickPicks(folders: readonly string[]): string[] {
  return folders.filter((folder) => folder !== "" && !folder.includes("/")).slice(0, 6);
}

/** One allowed address or domain, removable where the console may act. */
function SenderChip({
  entry,
  onRemove,
}: {
  entry: SenderEntry;
  onRemove?: () => void;
}) {
  if (onRemove === undefined) {
    return <Pill tone={entry.kind === "domain" ? "warn" : "neutral"}>{senderLabel(entry)}</Pill>;
  }
  return (
    <Button
      label={`${senderLabel(entry)}  ✕`}
      accessibilityLabel={`Stop allowing ${senderLabel(entry)}`}
      onPress={onRemove}
    />
  );
}

const styles = StyleSheet.create({
  rowSub: { marginTop: 2 },
  spaced: { marginTop: 11 },
  settings: { marginTop: 17, gap: 15 },
  quickPicks: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: -6 },
  readOnlyBlock: { gap: 2 },
  senders: { gap: 10 },
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  addRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, flexWrap: "wrap" },
  addField: { flexGrow: 1, flexShrink: 1, minWidth: 220 },
  addButton: { marginTop: 25 },
  actions: { gap: 9, flexWrap: "wrap" },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  okText: { color: colors.okText },
  warnText: { color: colors.warnText },
  inlineMono: { fontSize: 12 },
});
