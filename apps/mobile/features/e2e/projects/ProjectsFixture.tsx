/**
 * `/e2e-fixture?screen=projects` — a projects folder's page, the real
 * `FolderView` and everything under it (List, Board, Backlog, the side peek),
 * on an in-memory folder (`projectsStore.ts`), at whatever size the browser
 * is. `role=member` draws it for somebody who may only read.
 *
 * Why a fixture of its own: the console fixture's folder pages read this
 * device's copy through Convex, which a fixture build has no deployment
 * behind, so its List is always empty. Rows squeezing their titles to "Po…"
 * are a layout claim, which only a browser can check. Gated like every
 * screen of `/e2e-fixture` (`app/e2e-fixture.tsx`); nothing here reaches a
 * bucket.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { baseName } from "../../console/files/paths";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { FolderView } from "../../console/files/FolderView";
import type { FolderPageHost } from "../../console/files/folderPage/FolderPage";
import type { TaskHost } from "../../console/files/folderPage/tasks/taskHost";
import type { PeekEditing } from "../../console/files/folderPage/panel/peekEditing";
import type { EditorState } from "../../console/files/editor";
import { PROJECTS, projectsStore } from "./projectsStore";

interface Toast {
  readonly id: number;
  readonly message: string;
  readonly undo?: () => void;
}

export function ProjectsFixture({ member = false }: { member?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const store = useMemo(() => projectsStore({ canWrite: !member }), [member]);
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const [folder, setFolder] = useState(PROJECTS);
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  useEffect(() => store.subscribe(redraw), [store]);

  const tasks = useMemo<TaskHost | undefined>(
    () =>
      member
        ? undefined
        : {
            io: {
              create: async (path, text) => store.create(path, text),
              move: async (from, to) => store.move(from, to),
              setProperties: (path, changes, opts) => store.source.setProperties!(path, changes, opts),
              remove: async (path) => store.remove(path),
            },
            say: (message, undo) => setToasts((current) => [...current.slice(-2), { id: Date.now() + Math.random(), message, ...(undo === undefined ? {} : { undo }) }]),
            refresh: () => redraw(),
          },
    [member, store],
  );
  const editing = useFixtureEditor(store, !member);
  const page = useMemo<FolderPageHost>(
    () => ({
      source: store.source,
      workspaceId: "ws_fixture",
      people: ["Seyi", "Sayo", "Shyoh"],
      me: ["Seyi"],
      ...(tasks === undefined ? {} : { tasks }),
      editing,
    }),
    [store, tasks, editing],
  );
  const listing = store.listing(folder);
  return (
    <View style={styles.screen} testID="projects-fixture">
      <ScrollView contentContainerStyle={styles.page}>
        <FolderView
          entry={{ kind: "folder", path: folder, name: baseName(folder), visibility: "team", inherited: "team", exception: false, readOnly: false }}
          listing={listing}
          canSetVisibility={!member}
          contextLabel="@seyi"
          onSelect={(path) => {
            if (!path.endsWith(".md")) setFolder(path);
          }}
          page={page}
        />
      </ScrollView>
      {editing.editor.path === null ? null : (
        <Text variant="treeMeta" style={styles.saveMark} testID="fixture-save-mark">
          {`${editing.editor.path.split("/").slice(-2).join("/")} · ${editing.editor.status === "dirty" ? "Saving…" : "Saved"}`}
        </Text>
      )}
      <View style={styles.toasts} pointerEvents="box-none">
        {toasts.map((toast) => (
          <View key={toast.id} style={styles.toast} testID="fixture-toast">
            <Text variant="tree" style={styles.toastText}>
              {toast.message}
            </Text>
            {toast.undo === undefined ? null : (
              <Pressable
                onPress={() => {
                  toast.undo?.();
                  setToasts((current) => current.filter((each) => each.id !== toast.id));
                }}
                role="button"
                testID="fixture-toast-undo"
              >
                <Text variant="tree" style={styles.undo}>
                  Undo
                </Text>
              </Pressable>
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

type Held = Pick<EditorState, "path" | "draft" | "status" | "readOnly" | "encrypted">;
const EMPTY: Held = { path: null, draft: "", status: "clean", readOnly: false, encrypted: false };

/**
 * The console's one editor, as a fixture has it: one note at a time, a draft
 * that saves itself a moment after the last keystroke (the save mark in the
 * corner says which), written back to the in-memory folder so the List reads
 * what was typed. The real one is the file browser's (`usePeekEditing`).
 */
function useFixtureEditor(store: ReturnType<typeof projectsStore>, canEdit: boolean): PeekEditing {
  const [held, setHeld] = useState<Held>(EMPTY);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(held);
  latest.current = held;
  const save = useCallback(() => {
    const now = latest.current;
    if (now.path === null || now.status !== "dirty") return;
    store.write(now.path, now.draft);
    setHeld({ ...now, status: "saved" });
  }, [store]);
  const open = useCallback(
    (path: string) => {
      save();
      const text = store.text(path);
      if (text === null) return false;
      setHeld({ path, draft: text, status: "clean", readOnly: false, encrypted: false });
      return true;
    },
    [store, save],
  );
  const close = useCallback(
    (path: string) => {
      if (latest.current.path !== path) return true;
      save();
      setHeld(EMPTY);
      return true;
    },
    [save],
  );
  const onChange = useCallback(
    (text: string) => {
      setHeld((now) => ({ ...now, draft: text, status: "dirty" }));
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(save, 700);
    },
    [save],
  );
  return useMemo(() => ({ open, close, editor: held, canEdit, onChange, onSave: save }), [open, close, held, canEdit, onChange, save]);
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.pageSurface },
    page: { paddingHorizontal: space.x6, paddingVertical: space.x8 },
    toasts: { position: "absolute", left: 0, right: 0, bottom: space.x6, alignItems: "center", gap: space.x2 },
    toast: { flexDirection: "row", gap: space.x4, alignItems: "center", paddingHorizontal: space.x4, paddingVertical: space.x2, borderRadius: 8, backgroundColor: colors.text },
    toastText: { color: colors.pageSurface },
    undo: { color: colors.accent, fontWeight: "600" },
    saveMark: { position: "absolute", right: space.x4, bottom: space.x2, color: colors.muted },
  });
