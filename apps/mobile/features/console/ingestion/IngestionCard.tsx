import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
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
  ATTACHMENT_POLICIES,
  addSender,
  describeAttachmentPolicy,
  describeDraftProblem,
  describeIngestionAbsence,
  describeSenderPolicy,
  diff,
  draftOf,
  isDirty,
  isSenderProblem,
  normaliseFolder,
  receivesMail,
  refusalMessage,
  removeSender,
  senderEntries,
  senderLabel,
  type AttachmentPolicy,
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
 * mailing list, a screenshot — so the allow-list decides whether a message is
 * captured at all, and "anyone" is something you turn on deliberately, with the
 * consequence written out, rather than the state you end up in by not deciding.
 *
 * ## What the list is, and what this card must not imply it is
 *
 * This comment used to call the list "the security control", and the copy on
 * screen matched. It is not one. The receiver does not verify who sent a
 * message — see the "authentication is a label, not a gate" block in
 * `infra/email-worker/src/auth.ts` — so a sender who knows one address on
 * somebody's list can put that address in `From:` and be captured.
 *
 * What the list really does is keep the ordinary internet out: someone who
 * learns the address but not who is on it gets nothing. That is worth having
 * and worth configuring, and it is what the copy now says. What it must never
 * say, in any tone, is that a captured note came from who it claims — the
 * capture note itself carries that verdict, honestly, per message.
 *
 * Accurate, not alarming: a correctly configured list is still `ok`, because a
 * permanent warning on the right answer teaches people to ignore warnings.
 *
 * ## Two questions, asked in this order
 *
 * They were found by two different bugs and they gate two different things, so
 * the card asks both.
 *
 * **1. Does this context have an address at all?** Only a personal one does, so
 * a shared context is shown neither an address nor a form — an address that
 * will never receive mail, under a heading that says it will, is the one thing
 * here worse than no card at all. `describeIngestionAbsence` decides which of
 * the three empty states applies, and it keeps "this context has no address"
 * apart from "ingestion is off", which are different sentences about different
 * situations: the second is a setting an owner can change this afternoon. Two
 * of the three replace the card outright, before any address is drawn.
 *
 * **2. Is anything receiving at the other end?** There is no email receiver
 * deployed, and this card used to describe one in the present tense — "Forward
 * any email here and it lands in 0-inbox/", next to a Copy button. It was
 * believed. The address bounced.
 *
 * So every sentence about delivery, and the Copy button that invites somebody
 * to go and use the address right now, are gated on `receivesMail(state)` —
 * read its doc comment, which is where the two questions are `&&`-ed together.
 * The address itself is still shown and still selectable *for a context that
 * has one*, because it is the real address and will work unchanged the day the
 * receiver ships; what is withheld is the claim and the invitation.
 *
 * The allow-list and target-folder controls are deliberately **not** gated on
 * question 2. They save real rows, they are the posture the receiver will
 * enforce on its very first message, and an owner who sets them up in advance
 * has done something useful. Only the claims about what happens to mail are
 * held back. They *are* gated on question 1: there is no row to save for a
 * context the backend would refuse with `INGESTION_NOT_AVAILABLE`.
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
  const absence = describeIngestionAbsence(state);

  // Two of the three absences have nothing at all to put in the card — no
  // address to copy, no rules to read — so they replace it rather than sit
  // inside it. Showing the address anyway is what made this a lie: a shared
  // context was handed `slug@context.lc` and a Save button for an inbox it
  // does not have. Note this returns *after* every hook above, not before.
  if (absence !== null && absence.reason !== "off") {
    return (
      <Card>
        <Text variant="rowTitle">{absence.title}</Text>
        <Text variant="rowSub" style={styles.rowSub}>
          {absence.text}
        </Text>
      </Card>
    );
  }

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
        The "this address is not configurable yet on this deployment" notice
        stood here, drawn from `state.available`. It is gone with the flag: the
        generated `api` is `anyApi`, a proxy that mints a reference for any
        name, so the module-absence probe behind `available` could never answer
        false and the notice could never appear (issue #16). Its two delivery
        promises were rewritten by #36 first; removing the dead branch entirely
        is the rest of that fix, not a reversal of it.
      */}
      {/*
        `null` from `getIngestionSettings` is not "loading" and not "nearly
        configured" — the backend documents it as the fail-closed floor: no
        policy row at all. Said as what an owner has to *do*, not as what
        happens to mail in the meantime, because nothing happens to mail in the
        meantime either way.
      */}
      {absence?.reason === "off" ? (
        <Notice tone="warn" style={styles.spaced}>
          <Text variant="check" style={styles.warnText}>
            {absence.text}
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
              hint="Any folder in your brain. It does not have to exist yet."
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
              /*
                Both halves, in one sentence. The half an owner will assume is
                that a name on the list means the mail came from them, so the
                second clause is not optional — see the header of this file.
              */
              hint="Anyone who learns this address can try it. Only the senders below are allowed — though an email can claim to be from any address, so this filters rather than proves."
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
                  // "Nobody else." stood here. It read as a guarantee the list
                  // cannot make.
                  detail:
                    "Specific addresses, or whole domains. Anyone not on the list is turned away.",
                },
                {
                  value: "anyone",
                  label: "Anyone",
                  detail:
                    "An open drop-box. Anyone who learns the address — a forwarded thread, a mailing list, a screenshot — can put a note in your brain.",
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

          {canEdit ? (
            <ChoiceGroup
              label="What happens to attachments"
              hint="Files arrive from the same unverified sender as the text. This is what Context does with them."
              value={shown.attachmentPolicy}
              onChange={(value) =>
                setDraft((current) =>
                  current === null
                    ? current
                    : { ...current, attachmentPolicy: value as AttachmentPolicy },
                )
              }
              options={ATTACHMENT_POLICIES.map((policy) => ({
                value: policy,
                ...describeAttachmentPolicy(policy),
              }))}
              testID="ingestion-attachments"
            />
          ) : (
            <View style={styles.readOnlyBlock}>
              <Text variant="eyebrow">Attachments</Text>
              <Text variant="rowSub">
                {describeAttachmentPolicy(shown.attachmentPolicy).label}
              </Text>
            </View>
          )}

          {shown.attachmentPolicy === "store" ? (
            <Notice tone="warn">
              <Text variant="check" style={styles.warnText}>
                Images sent to this address are written into your bucket. They came from
                whoever sent the mail, and nothing checked them.
              </Text>
            </Notice>
          ) : null}

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
