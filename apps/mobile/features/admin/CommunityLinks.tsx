/**
 * Community links: the outside places staff point people at — the Discord
 * join link, the GitHub repository, the newsletter.
 *
 * They live in the Waitlist tab because they are part of letting people in:
 * the Discord link is shown at the end of setup. A link marked "Signed-in
 * people only" is never sent to somebody who is not in; that is decided by
 * the server, and this panel only says so.
 *
 * The server refuses anything that is not `https://`, and its sentence is
 * shown under the form as it came, rather than a guess made here.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Text, TextField, leading, space, useThemedStyles, type Colors } from "../design";
import { TextLink } from "../design/components/TextLink";
import { pointerType } from "../design/tokens";
import { EmptyNote, Panel, Skeleton, useCompact, usePanelPad } from "./AdminKit";
import { Segments } from "./Segments";
import { messageFor } from "./SecretDialogs";
import {
  COMMUNITY_AUDIENCES,
  COMMUNITY_KINDS,
  audienceLabel,
  kindDefaults,
  type CommunityAudience,
  type CommunityKind,
  type CommunityLink,
} from "./referrals";

export function CommunityLinks() {
  const styles = useThemedStyles(makeStyles);
  const pad = usePanelPad();
  const links = useQuery(api.functions.admin.listCommunityLinks, {});
  const remove = useMutation(api.functions.admin.deleteCommunityLink);
  /** `"new"` for the add form, a link's id for its edit form, or nothing open. */
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onDelete(link: CommunityLink) {
    setError(null);
    try {
      await remove({ id: link.id as Id<"communityLinks"> });
      if (editing === link.id) setEditing(null);
    } catch (caught) {
      setError(messageFor(caught, "That did not work. Try again."));
    }
  }

  return (
    <Panel
      title="Community links"
      flush
      testID="admin-community-links"
    >
      <Text variant="meta" style={[styles.lead, { paddingHorizontal: pad.x }]}>
        The Discord link shows at the end of setup and in everyone's account menu. Only people who are in can
        see links marked Signed-in people only.
      </Text>
      {links === undefined ? (
        <View style={{ padding: pad.x }}>
          <Skeleton width="100%" height={48} />
        </View>
      ) : links.length === 0 && editing !== "new" ? (
        <EmptyNote title="No links yet" body="Add the Discord join link so new people can find everyone." />
      ) : (
        links.map((link) =>
          editing === link.id ? (
            <LinkForm key={link.id} link={link} onDone={() => setEditing(null)} />
          ) : (
            <View key={link.id} style={[styles.row, { paddingHorizontal: pad.x }]} testID={`admin-link-${link.id}`}>
              <View style={styles.rowMain}>
                <Text variant="rowTitle" style={styles.label}>
                  {link.label}
                </Text>
                <Text variant="meta" numberOfLines={1} style={styles.url}>
                  {link.url}
                </Text>
                <Text variant="meta">{audienceLabel(link.audience)}</Text>
              </View>
              <View style={styles.rowButtons}>
                <TextLink
                  label="Edit"
                  accessibilityLabel={`Edit ${link.label}`}
                  onPress={() => setEditing(link.id)}
                  testID={`admin-link-edit-${link.id}`}
                />
                <Button
                  label="Delete"
                  variant="danger"
                  accessibilityLabel={`Delete ${link.label}`}
                  onPress={() => onDelete(link)}
                  testID={`admin-link-delete-${link.id}`}
                />
              </View>
            </View>
          ),
        )
      )}
      {error ? (
        <Text variant="error" role="alert" style={{ paddingHorizontal: pad.x }}>
          {error}
        </Text>
      ) : null}
      {editing === "new" ? (
        <LinkForm onDone={() => setEditing(null)} />
      ) : (
        <View style={[styles.addRow, { paddingHorizontal: pad.x }]}>
          <Button label="Add link" onPress={() => setEditing("new")} testID="admin-link-add-open" />
        </View>
      )}
    </Panel>
  );
}

/** Add a link, or edit one when `link` is given. */
function LinkForm({ link, onDone }: { link?: CommunityLink; onDone: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const pad = usePanelPad();
  const save = useMutation(api.functions.admin.saveCommunityLink);
  const start = link ?? { kind: "discord" as const, url: "", ...kindDefaults("discord") };
  const [kind, setKind] = useState<CommunityKind>(start.kind);
  const [label, setLabel] = useState(start.label);
  const [url, setUrl] = useState(start.url);
  const [audience, setAudience] = useState<CommunityAudience>(start.audience);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pickKind(next: CommunityKind) {
    // Replace the label only if it is still the one the last kind suggested.
    if (label.trim() === "" || label === kindDefaults(kind).label) setLabel(kindDefaults(next).label);
    if (link === undefined) setAudience(kindDefaults(next).audience);
    setKind(next);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await save({
        ...(link ? { id: link.id as Id<"communityLinks"> } : {}),
        kind,
        label: label.trim(),
        url: url.trim(),
        audience,
      });
      onDone();
    } catch (caught) {
      setError(messageFor(caught, "That did not save. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.form, { paddingHorizontal: pad.x }]} testID="admin-link-form">
      <Text variant="eyebrow">Kind</Text>
      <Segments
        options={COMMUNITY_KINDS}
        value={kind}
        onChange={pickKind}
        role="radiogroup"
        label="Kind"
        testID="admin-link-kind"
      />
      <TextField label="Label" value={label} onChangeText={setLabel} testID="admin-link-label" />
      <TextField
        label="URL"
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://"
        hint="Must start with https://"
        testID="admin-link-url"
      />
      <Text variant="eyebrow">Who can see it</Text>
      <Segments
        options={COMMUNITY_AUDIENCES}
        value={audience}
        onChange={setAudience}
        role="radiogroup"
        label="Who can see it"
        testID="admin-link-audience"
      />
      {error ? (
        <Text variant="error" role="alert" testID="admin-link-error">
          {error}
        </Text>
      ) : null}
      <View style={[styles.formActions, compact && styles.formActionsCompact]}>
        <Button label="Cancel" variant="dialog" onPress={onDone} />
        <Button
          label={busy ? "Saving…" : link ? "Save" : "Add link"}
          variant="dialogPrimary"
          disabled={busy || label.trim() === "" || url.trim() === ""}
          onPress={submit}
          testID="admin-link-save"
        />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    lead: { marginBottom: space.x2 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingVertical: space.x3,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    rowMain: { flex: 1, minWidth: 0, gap: 2 },
    rowButtons: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    label: { fontSize: pointerType.ui, lineHeight: leading(pointerType.ui, 1.55) },
    url: { color: colors.text2 },
    addRow: { paddingVertical: space.x3, borderTopWidth: 1, borderTopColor: colors.line, alignItems: "flex-start" },
    form: {
      gap: space.x3,
      paddingVertical: space.x4,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    formActions: { flexDirection: "row", justifyContent: "flex-end", gap: space.x2 },
    formActionsCompact: { flexDirection: "column-reverse", alignItems: "stretch" },
  });
