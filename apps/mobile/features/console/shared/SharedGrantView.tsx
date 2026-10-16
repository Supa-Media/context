import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";

import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { baseName, displayName } from "../files/paths";
import { SharedNoteShown, type Loaded } from "./SharedNoteView";
import { grantQuery, type GrantTarget } from "./sharedGrant";
import { itemTitle, SHARED_HREF, type SharedItem } from "./sharedInbox";

/**
 * A row you hold a grant on, open in place (board A3's reading, for a grant).
 *
 * The same page a share is, with the read done by `shares.readGrantedNote` (a
 * note) or `shares.listGrantedFolder` (a folder), addressed by the grant's note
 * id or, for a note reached from a folder, its path. Read only: this never opens
 * a live room, so nothing here can write. A link inside a granted note opens
 * that note as a grant too, and the server refuses it unless it is granted.
 */
export function SharedGrantView({
  target,
  item,
  phone,
  now,
  onList,
  onGo,
}: {
  target: GrantTarget;
  /** The list's row for this grant, for the title and the byline; `null` when it is not in the list (a path reached from a folder). */
  item: SharedItem | null;
  phone: boolean;
  now: number;
  onList: () => void;
  onGo: (href: string) => void;
}) {
  if (target.folder) return <GrantedFolder target={target} item={item} onList={onList} onGo={onGo} />;
  return <GrantedNote target={target} item={item} phone={phone} now={now} onList={onList} onGo={onGo} />;
}

/** The address of a granted row, as an href on @shared. */
export function grantHrefOf(target: GrantTarget): string {
  return `${SHARED_HREF}${grantQuery(target)}`;
}

/** The arguments `shares.readGrantedNote` and `shares.listGrantedFolder` take for this address. */
function grantArgs(workspaceId: string, by: "id" | "path", ref: string) {
  const id = workspaceId as Id<"workspaces">;
  return by === "id" ? { workspaceId: id, noteId: ref } : { workspaceId: id, path: ref };
}

function GrantedNote({
  target,
  item,
  phone,
  now,
  onList,
  onGo,
}: {
  target: GrantTarget;
  item: SharedItem | null;
  phone: boolean;
  now: number;
  onList: () => void;
  onGo: (href: string) => void;
}) {
  const read = useAction(api.functions.shares.readGrantedNote);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const { workspaceId } = target;
  const by = target.ref.by;
  const ref = target.ref.by === "id" ? target.ref.noteId : target.ref.path;

  useEffect(() => {
    let live = true;
    setLoaded({ kind: "loading" });
    read(grantArgs(workspaceId, by, ref))
      .then((note) => {
        if (live) setLoaded({ kind: "note", path: note.path, text: note.text });
      })
      .catch(() => {
        if (live) setLoaded({ kind: "refused" });
      });
    return () => {
      live = false;
    };
  }, [read, workspaceId, by, ref]);

  return (
    <SharedNoteShown
      loaded={loaded}
      token={null}
      item={item}
      phone={phone}
      now={now}
      onList={onList}
      onGo={onGo}
      linkHref={(path) => grantHrefOf({ workspaceId, ref: { by: "path", path }, folder: false })}
    />
  );
}

type Entry = { path: string; name: string; kind: "file" | "folder" };
type Listing = { kind: "loading" } | { kind: "listing"; path: string; entries: Entry[] } | { kind: "refused" };

/** A granted folder: the list of what the grant lets you see in it. Each row opens by its path. */
function GrantedFolder({
  target,
  item,
  onList,
  onGo,
}: {
  target: GrantTarget;
  item: SharedItem | null;
  onList: () => void;
  onGo: (href: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const list = useAction(api.functions.shares.listGrantedFolder);
  const [state, setState] = useState<Listing>({ kind: "loading" });
  const { workspaceId } = target;
  const by = target.ref.by;
  const ref = target.ref.by === "id" ? target.ref.noteId : target.ref.path;

  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    list(grantArgs(workspaceId, by, ref))
      .then((answer) => {
        if (live) setState({ kind: "listing", path: answer.path, entries: answer.entries });
      })
      .catch(() => {
        if (live) setState({ kind: "refused" });
      });
    return () => {
      live = false;
    };
  }, [list, workspaceId, by, ref]);

  const name = item === null ? (state.kind === "listing" ? displayName(baseName(state.path)) : "Folder") : itemTitle(item);

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content} testID="shared-grant-folder">
      <View style={styles.head}>
        <PressRow accessibilityLabel="Shared with me" onPress={onList} radius={radii.sm} style={styles.crumb} testID="shared-grant-root">
          <Text variant="treeMetaMono">Shared with me</Text>
        </PressRow>
        <Text variant="treeMetaMono">/</Text>
        <Text variant="treeMetaMono" numberOfLines={1} style={styles.grow}>
          {name}
        </Text>
        <Pill>Can read</Pill>
      </View>

      {state.kind === "loading" ? null : state.kind === "refused" ? (
        <View style={styles.message}>
          <Text variant="rowTitle">This folder isn't shared with you any more.</Text>
          <Text variant="rowSub">Its owner may have stopped sharing it, or moved it somewhere it can't be read.</Text>
        </View>
      ) : state.entries.length === 0 ? (
        <View style={styles.message}>
          <Text variant="rowSub">Nothing in this folder is shared with you.</Text>
        </View>
      ) : (
        state.entries.map((entry) => (
          <PressRow
            key={entry.path}
            accessibilityLabel={`${entry.name}${entry.kind === "folder" ? ", folder" : ""}`}
            onPress={() =>
              onGo(
                grantHrefOf({
                  workspaceId,
                  ref: { by: "path", path: entry.path },
                  folder: entry.kind === "folder",
                }),
              )
            }
            radius={radii.sm}
            style={styles.row}
            hoverStyle={styles.rowHover}
            testID={`shared-grant-entry-${entry.path}`}
          >
            <Icon name={entry.kind === "folder" ? "folder" : "file"} size={14} />
            <Text variant="tree" numberOfLines={1} style={styles.grow}>
              {entry.name}
            </Text>
          </PressRow>
        ))
      )}
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { flex: 1, minHeight: 0 },
    content: { paddingHorizontal: space.x7, paddingTop: space.x3, paddingBottom: space.x8, gap: space.x1 },
    head: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingBottom: space.x3 },
    crumb: { paddingHorizontal: 2 },
    grow: { flex: 1, minWidth: 0, color: colors.text },
    row: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingVertical: space.x2, paddingHorizontal: space.x2 },
    rowHover: { backgroundColor: colors.surface3 },
    message: { padding: space.x4, gap: space.x2, maxWidth: 560 },
  });
