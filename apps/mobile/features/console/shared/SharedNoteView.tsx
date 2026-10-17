import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";

import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { editorReducer, emptyEditor } from "../files/editor";
import { NoteEditor } from "../files/NoteEditor";
import { PersonFace } from "../faces/PersonFace";
import { ReportLink } from "../../report/ReportLink";
import type { GrantEditing } from "./useGrantEditor";
import {
  itemTitle,
  reportPersonOf,
  reportTargetOf,
  sharedLinkHref,
  sharerFace,
  sharerLabel,
  shortWhen,
  type SharedItem,
} from "./sharedInbox";

export type Loaded =
  | { kind: "loading" }
  | { kind: "note"; path: string; text: string }
  /** A folder share, which the share's own page lists: @shared opens notes. */
  | { kind: "folder" }
  | { kind: "refused" };

const nothing = () => {};

/**
 * One shared note, open inside @shared (board A3): the path starts at Shared
 * with me and names whose it is, the pill says what you can do, once, and the
 * note is drawn by the real editor — the same `NoteEditor` every note in the
 * app is, read only (`canEdit` false) unless a grant gives edit, when
 * `SharedNoteShown` gets `editing` and saves through it.
 *
 * The text comes from `shares.readSharedNote` with the row's token, the one
 * read path a share has, so this page can reach exactly what the share's own
 * link reaches and no more.
 */
export function SharedNoteView({
  token,
  item,
  phone,
  now,
  onList,
  onGo,
}: {
  token: string;
  /** The list's row for this token, for the path and the byline; `null` until it arrives. */
  item: SharedItem | null;
  phone: boolean;
  now: number;
  onList: () => void;
  /** Leave for another address: a link inside the note, or a shared folder's own page. */
  onGo: (href: string) => void;
}) {
  const read = useAction(api.functions.shares.readSharedNote);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    setLoaded({ kind: "loading" });
    read({ token })
      .then((note) => {
        if (!live) return;
        setLoaded(
          note.kind === "note" && note.text !== null
            ? { kind: "note", path: note.path, text: note.text }
            : { kind: "folder" },
        );
      })
      .catch(() => {
        if (live) setLoaded({ kind: "refused" });
      });
    return () => {
      live = false;
    };
  }, [read, token]);

  return <SharedNoteShown loaded={loaded} token={token} item={item} phone={phone} now={now} onList={onList} onGo={onGo} />;
}

/** The page once read, with no server: what the fixture and the tests draw. */
export function SharedNoteShown({
  loaded,
  token,
  item,
  phone,
  now,
  onList,
  onGo,
  linkHref,
  editing,
}: {
  loaded: Loaded;
  /** The share's token, which its links follow; `null` for a grant, which has none. */
  token: string | null;
  item: SharedItem | null;
  phone: boolean;
  now: number;
  onList: () => void;
  onGo: (href: string) => void;
  /** Where a link inside the note goes, for a grant (a share's links follow its own page). */
  linkHref?: (target: string) => string;
  /** A grant you may edit: the note is drawn writable and saves through it. Absent, or `null`, it is read only. */
  editing?: GrantEditing | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const readState = useMemo(
    () =>
      loaded.kind === "note"
        ? editorReducer(emptyEditor, {
            type: "opened",
            note: {
              path: loaded.path,
              text: loaded.text,
              etag: "",
              visibility: "team",
              inherited: "team",
              exception: false,
              // `canEdit` below is what keeps it read only; `readOnly` would add privacy.md's notice.
              readOnly: false,
            },
          })
        : null,
    [loaded],
  );
  const canEdit = editing !== null && editing !== undefined && editing.state.path !== null;
  const state = canEdit ? editing.state : readState;

  const title = item === null ? null : itemTitle(item);
  const who = item === null ? null : sharerLabel(item);
  const when = item === null ? null : shortWhen(item.createdAt, now).replace(/^Just now$/, "just now");

  const path = (
    <View style={[styles.pathRow, phone && styles.pathRowPhone]}>
      {phone ? (
        <PressRow
          accessibilityLabel="Back to Shared with me"
          onPress={onList}
          radius={radii.pill}
          style={styles.back}
          testID="shared-note-back"
        >
          <Icon name="chevronLeft" size={16} />
        </PressRow>
      ) : (
        <View style={styles.crumbs} role="navigation" aria-label="Path">
          <PressRow accessibilityLabel="Shared with me" onPress={onList} radius={radii.sm} style={styles.crumb} testID="shared-crumb-root">
            <Text variant="treeMetaMono">Shared with me</Text>
          </PressRow>
          {who === null ? null : (
            <>
              <Text variant="treeMetaMono">/</Text>
              <Text variant="treeMetaMono" numberOfLines={1}>
                {who}
              </Text>
            </>
          )}
          {title === null ? null : (
            <>
              <Text variant="treeMetaMono">/</Text>
              <Text variant="treeMetaMono" numberOfLines={1} style={styles.leaf}>
                {title}
              </Text>
            </>
          )}
        </View>
      )}
      <Pill>{canEdit ? "Can edit" : "Can read"}</Pill>
      {phone ? <View style={styles.backSpacer} /> : null}
    </View>
  );

  const byline =
    item === null ? null : (
      <View style={[styles.byline, phone && styles.bylinePhone]} testID="shared-byline">
        <PersonFace name={sharerFace(item)} size={18} />
        <Text variant="rowSub" numberOfLines={1} style={styles.grow}>
          <Text variant="rowSub" style={styles.who}>
            {who}
          </Text>
          {` shared this with you · ${when}`}
        </Text>
        <ReportLink target={reportTargetOf(item)} person={reportPersonOf(item)} testID="shared-note-report" />
      </View>
    );

  return (
    <View style={styles.page} testID="shared-note">
      {/* A phone's path goes inside the note's own scroller, under the floating chrome, as Browse's does. */}
      {phone && state !== null ? null : path}
      {state !== null ? (
        <>
          {phone ? null : byline}
          <View style={styles.editor}>
            <NoteEditor
              state={state}
              canEdit={canEdit}
              reading={!canEdit}
              // Not your bucket, and nothing to save: the foot says nothing (`noteFoot`). An editor's saves do reach
              // the owner's bucket, so their foot says so.
              local={!canEdit}
              pathBar={phone ? path : undefined}
              notices={phone ? byline : undefined}
              onChange={canEdit ? editing.onChange : nothing}
              onSave={canEdit ? editing.onSave : nothing}
              onDiscard={canEdit ? editing.onDiscard : nothing}
              onUseTheirs={canEdit ? editing.onUseTheirs : nothing}
              onKeepMine={canEdit ? editing.onKeepMine : nothing}
              // A link in the note follows the share's own reach, on its own page.
              onOpenLink={(target) =>
                onGo(linkHref ? linkHref(target) : `${sharedLinkHref(token ?? "")}?path=${encodeURIComponent(target)}`)
              }
            />
          </View>
        </>
      ) : (
        <View style={styles.message}>
          {loaded.kind === "loading" ? null : (
            <>
              <Text variant="rowTitle">
                {loaded.kind === "folder" ? "This is a shared folder." : "This note isn't shared with you any more."}
              </Text>
              {loaded.kind === "folder" ? (
                <PressRow
                  accessibilityLabel="Open the folder"
                  onPress={() => onGo(sharedLinkHref(token ?? ""))}
                  radius={radii.sm}
                  style={styles.link}
                >
                  <Text variant="rowSub" style={styles.who}>
                    Open the folder
                  </Text>
                </PressRow>
              ) : (
                <Text variant="rowSub">Its owner may have stopped sharing it, or moved it somewhere it can't be read.</Text>
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { flex: 1, minHeight: 0 },
    pathRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: space.x7,
      paddingTop: space.x3,
      paddingBottom: space.x2,
    },
    pathRowPhone: { justifyContent: "space-between", paddingHorizontal: space.x6 },
    crumbs: { flexDirection: "row", alignItems: "center", gap: space.x2, flexShrink: 1, minWidth: 0 },
    crumb: { paddingHorizontal: 2 },
    leaf: { color: colors.text, flexShrink: 1 },
    back: {
      width: 36,
      height: 36,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    backSpacer: { width: 36 },
    byline: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      width: "100%",
      // On the note's own measure, so the byline starts where its first line does.
      maxWidth: layout.readingMeasureEm * layout.noteFontSize + layout.notePadX * 2,
      alignSelf: "center",
      paddingHorizontal: layout.notePadX,
      paddingTop: space.x2,
    },
    bylinePhone: { paddingHorizontal: space.x6, paddingTop: 0, paddingBottom: space.x2 },
    grow: { flex: 1, minWidth: 0 },
    who: { color: colors.text, fontWeight: "600" },
    editor: { flex: 1, minHeight: 0 },
    message: { padding: space.x7, gap: space.x2, maxWidth: 560 },
    link: { alignSelf: "flex-start" },
  });
