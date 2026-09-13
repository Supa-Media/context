import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useConvex, useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { suggestDestinationFolders } from "@context/communications";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { FormError, TextField } from "../../../design/components/Input";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import {
  INBOX_FOLDER,
  canSaveMeetingFolder,
  meetingFolderProblem,
} from "../../../meetings/destination";

/**
 * Where meetings land, as a control rather than a sentence.
 *
 * ## The gap this closes
 *
 * It was the one capture destination a person could not change. A Google
 * account carries an editable folder per service and forwarded mail carries a
 * target folder; a meeting carried `INBOX_FOLDER` — a constant — interpolated
 * into a paragraph on this panel, with no control beside it and no setter
 * anywhere in the codebase. Somebody who files meetings under
 * `2-areas/meetings` had to move every note by hand, forever.
 *
 * ## What it does not change, and must not
 *
 * **The destination is still asked for every time, before the microphone
 * opens.** `features/meetings/destination.ts` argues that at length and this
 * changes none of it: the first offer is always the person's own workspace, the
 * page they are standing on is offered second with its audience named, and no
 * setting answers the question silently. What this names is the folder the
 * *first offer points at*.
 *
 * That distinction is the whole reason the setting did not exist — the panel's
 * docstring defended the absence with the "asked every time" rule, which is
 * about a different question. So the second row below states the part that is
 * not configurable, rather than leaving a reader to infer it from silence.
 *
 * ## Absent rather than disabled
 *
 * The control needs `setMeetingsFolder`, which is owner-only and personal-only
 * on the backend. A member, a shared workspace, and the landing page's console
 * — which has no Convex client at all — are each shown the folder and no way to
 * change it, rather than a button whose only outcome is a permission error.
 */
export function MeetingsDestination({
  workspaceId,
  slug,
  kind,
  role,
  folder,
  folders,
}: {
  workspaceId: string | null;
  slug: string;
  /** `personal` | `shared`. Only a personal workspace reads this setting. */
  kind: string;
  role: string | undefined;
  /** The stored folder, or `undefined` for a context that has never chosen. */
  folder: string | undefined;
  /** Folders the console has loaded, offered as completions. */
  folders: readonly string[];
}) {
  const styles = useThemedStyles(makeStyles);
  /*
    `useConvex` answers `undefined` rather than throwing where there is no
    provider — the landing page's copy of this console, and the render
    harnesses. `useMutation` is only reached through `MeetingsDestinationLive`,
    which is not rendered in that case: a conditional *component*, never a
    conditional hook. Same shape as `PremiumPanel`.
  */
  const client = useConvex();
  const stored = folder ?? INBOX_FOLDER;
  const canChange =
    client !== undefined && workspaceId !== null && kind === "personal" && role === "owner";

  return (
    <View>
      <Text variant="eyebrow" style={styles.head}>
        Where the notes land
      </Text>
      <Text variant="paneSub" style={styles.sub}>
        You are asked every time, before the microphone opens. This is what the first
        offer points at.
      </Text>

      {canChange ? (
        <MeetingsDestinationLive
          workspaceId={workspaceId as Id<"workspaces">}
          stored={stored}
          folders={folders}
        />
      ) : (
        <Card>
          <Row>
            <Grow>
              <Text variant="rowTitle">
                {kind === "shared" ? "Meetings filed here" : "Default folder in your workspace"}
              </Text>
              <Text variant="mono" style={styles.folder}>
                {stored}
              </Text>
            </Grow>
          </Row>
          <Text variant="foot" style={styles.readOnly}>
            {kind === "shared"
              ? "Meetings are offered your own workspace first, so the folder is a setting on a personal workspace rather than on a shared one."
              : `Only the owner of ${slug} can change where its meetings land.`}
          </Text>
        </Card>
      )}

      <SecondOffer kind={kind} />
    </View>
  );
}

/**
 * The offer that is not a setting, stated rather than left to inference.
 *
 * A panel that showed one configurable row and nothing else would read as
 * though the folder were the whole answer. It is half of it: the second offer
 * follows wherever you are standing, and is asked for every time.
 */
function SecondOffer({ kind }: { kind: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Card style={styles.second}>
      <Row style={styles.secondRow}>
        <Grow>
          <Text variant="rowTitle">Second offer</Text>
          <Text variant="rowSub" style={styles.folder}>
            {kind === "shared"
              ? "Whatever you are looking at when you press record — this workspace included, with its audience written on the row."
              : "Whatever you are looking at when you press record, with its audience written on the row."}
          </Text>
        </Grow>
        <Pill tone="neutral">Always asked</Pill>
      </Row>
    </Card>
  );
}

/** The half that mutates. Rendered only where there is a client to do it. */
function MeetingsDestinationLive({
  workspaceId,
  stored,
  folders,
}: {
  workspaceId: Id<"workspaces">;
  stored: string;
  folders: readonly string[];
}) {
  const styles = useThemedStyles(makeStyles);
  const setFolder = useMutation(api.functions.workspaces.setMeetingsFolder);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const problem = meetingFolderProblem(draft);
  const canSave = canSaveMeetingFolder(draft, stored);
  const suggestions = useMemo(
    () => suggestDestinationFolders(draft, folders),
    [draft, folders],
  );

  const open = () => {
    setDraft(stored);
    setFailure(null);
    setEditing(true);
  };

  const save = () => {
    setSaving(true);
    setFailure(null);
    void setFolder({ workspaceId, folder: draft })
      .then(() => setEditing(false))
      .catch((reason: unknown) =>
        /*
          The control plane's own sentence. `setMeetingsFolder` refuses with a
          message written to be shown — a folder the gateway will not file
          into, or a workspace that is not their own — and replacing it with
          "try again" would hide the only thing that says what to fix.
        */
        setFailure(reason instanceof Error ? reason.message : "That folder did not save."),
      )
      .finally(() => setSaving(false));
  };

  return (
    <Card>
      <Row>
        <Grow>
          <Text variant="rowTitle">Default folder in your workspace</Text>
          <Text variant="mono" style={styles.folder}>
            {stored}
          </Text>
        </Grow>
        {editing ? null : (
          <Button
            label="Change"
            accessibilityLabel="Change the folder meetings are offered first"
            onPress={open}
            testID="meetings-folder-edit"
          />
        )}
      </Row>

      {editing ? (
        <View style={styles.editor}>
          <TextField
            label="Default folder"
            value={draft}
            onChangeText={(value) => {
              setDraft(value);
              setFailure(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={INBOX_FOLDER}
            hint="A folder inside your workspace. You are still asked before every recording."
            error={problem ?? undefined}
            style={styles.input}
            testID="meetings-folder-input"
          />

          {suggestions.length === 0 ? null : (
            <View style={styles.suggestions}>
              {suggestions.map((suggestion) => (
                <Button
                  key={suggestion}
                  label={suggestion}
                  variant="mini"
                  accessibilityLabel={`Use ${suggestion}`}
                  onPress={() => setDraft(suggestion)}
                  testID={`meetings-folder-suggest-${suggestion}`}
                />
              ))}
            </View>
          )}

          <Row style={styles.actions}>
            <Button
              label={saving ? "Saving…" : "Save"}
              disabled={!canSave || saving}
              onPress={save}
              testID="meetings-folder-save"
            />
            <Button
              label="Cancel"
              variant="ghost"
              disabled={saving}
              onPress={() => {
                setDraft(stored);
                setFailure(null);
                setEditing(false);
              }}
              testID="meetings-folder-cancel"
            />
            {/*
              Back to the default, and only where it would do something. A
              button that clears a choice nobody has made is a control whose
              press changes nothing.
            */}
            {stored === INBOX_FOLDER ? null : (
              <Button
                label="Use the default"
                variant="ghost"
                disabled={saving}
                accessibilityLabel={`Go back to ${INBOX_FOLDER}`}
                onPress={() => setDraft(INBOX_FOLDER)}
                testID="meetings-folder-default"
              />
            )}
          </Row>
        </View>
      ) : null}

      {failure === null ? null : (
        <FormError headline="That folder did not save" next={failure} style={styles.failure} />
      )}
    </Card>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    head: { marginTop: space.x6 },
    sub: { marginBottom: space.x3, maxWidth: 546 },
    folder: { marginTop: 3 },
    readOnly: { marginTop: space.x3 },
    second: { marginTop: space.x3 },
    secondRow: { alignItems: "flex-start", flexWrap: "wrap", gap: space.x3 },
    editor: { marginTop: space.x3, gap: space.x3 },
    input: { fontFamily: "JetBrainsMono_400Regular", fontSize: 12.5 },
    suggestions: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    actions: { gap: 9, flexWrap: "wrap" },
    failure: { marginTop: space.x3 },
  });
