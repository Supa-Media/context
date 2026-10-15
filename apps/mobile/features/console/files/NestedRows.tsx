/**
 * A folder row's children, drawn under it when its arrow is pressed.
 *
 * The owner, 2026-10-14: "I'm realizing that the arrow isn't even clickable,
 * which is stupid." The desktop listing draws a chevron before every folder
 * because the tree does, and in the tree it opens the folder in place, so it
 * does here too: the arrow turns down and the folder's rows follow it,
 * indented a step, each with its own arrow. The rest of the row still opens
 * the folder's page, as before.
 *
 * A child folder's listing is the file browser's own (`listingOf`), fetched
 * the first time it is opened (`loadListing`) and kept current the way the
 * tree's is, so the two never disagree about what is in a folder. Which rows
 * are open is this page's alone, forgotten when another folder is shown.
 * Only on a pointer layout: a phone's row is a card that goes somewhere, and
 * its trailing chevron says so.
 */

import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { useThemedStyles, type Colors } from "../../design/theme";
import { FolderRow, NEST_INDENT } from "./FolderRow";
import type { FolderListing, FileEntry } from "./types";
import { listedEntries } from "./tree";

export interface RowNesting {
  /** The file browser's listing of a folder, or undefined until it has one. */
  listingOf: (path: string) => FolderListing | undefined;
  /** Fetch a folder's listing into the file browser, a no-op once it is there. */
  loadListing: (path: string) => void;
}

/** The folders opened in place on the page showing `folder`; all closed again on another. */
export function useOpenRows(folder: string, nesting: RowNesting | undefined) {
  const [open, setOpen] = useState<{ at: string; paths: ReadonlySet<string> }>({ at: folder, paths: new Set() });
  const paths = open.at === folder ? open.paths : EMPTY;
  const load = nesting?.loadListing;
  const toggle = useCallback(
    (path: string) => {
      setOpen((now) => {
        const current = now.at === folder ? now.paths : EMPTY;
        const next = new Set(current);
        if (next.has(path)) {
          // Closing a folder closes what was open inside it, as the tree does.
          for (const each of current) if (each === path || each.startsWith(`${path}/`)) next.delete(each);
        } else next.add(path);
        return { at: folder, paths: next };
      });
      load?.(path);
    },
    [folder, load],
  );
  return { paths, toggle: nesting === undefined ? undefined : toggle };
}

const EMPTY: ReadonlySet<string> = new Set();

type RowProps = Omit<Parameters<typeof FolderRow>[0], "row" | "depth" | "expanded" | "onToggle" | "folderIcon">;

/** The rows inside `parent`, at `depth`, each folder among them openable in turn. */
export function NestedRows({
  parent,
  depth,
  nesting,
  open,
  onToggle,
  descending,
  rowProps,
  iconOf,
}: {
  parent: string;
  depth: number;
  nesting: RowNesting;
  open: ReadonlySet<string>;
  onToggle: (path: string) => void;
  descending: boolean;
  rowProps: (row: FileEntry) => RowProps;
  iconOf?: (path: string) => string | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const listing = nesting.listingOf(parent);
  const load = nesting.loadListing;
  // Opened before this page had its listing (a reload with it open): ask again.
  useEffect(() => {
    if (listing === undefined) load(parent);
  }, [listing, load, parent]);
  if (listing === undefined) {
    return (
      <Text variant="treeMeta" style={[styles.note, { paddingLeft: indent(depth) }]} testID="folder-row-children-loading">
        Loading…
      </Text>
    );
  }
  const rows = listedEntries(listing.entries, { descending });
  if (rows.length === 0) {
    return (
      <Text variant="treeMeta" style={[styles.note, { paddingLeft: indent(depth) }]} testID="folder-row-children-empty">
        Nothing in here yet.
      </Text>
    );
  }
  return (
    <View testID="folder-row-children">
      {rows.map((row) => (
        <View key={row.path}>
          <FolderRow
            {...rowProps(row)}
            row={row}
            depth={depth}
            expanded={open.has(row.path)}
            onToggle={row.kind === "folder" ? () => onToggle(row.path) : undefined}
            folderIcon={iconOf?.(row.path) ?? null}
          />
          {row.kind === "folder" && open.has(row.path) ? (
            <NestedRows
              parent={row.path}
              depth={depth + 1}
              nesting={nesting}
              open={open}
              onToggle={onToggle}
              descending={descending}
              rowProps={rowProps}
              {...(iconOf === undefined ? {} : { iconOf })}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** A level's indent, past the chevron's gutter, so an empty line sits under its folder's name. */
function indent(depth: number): number {
  return depth * NEST_INDENT + 18 + 6;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    note: { color: colors.chromeMuted, paddingVertical: 6 },
  });
