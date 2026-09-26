/**
 * A workspace's own emoji, for everything on screen that shows or adds them:
 * the editor's `:` menu and drawn `:name:`, the Add emoji dialog, and
 * Settings › Emoji.
 *
 * The provider holds the list and the dialog; the editor reaches it through
 * `CustomEmojiContext`, as an `EmojiHostContext`, so none of the note editor's
 * props had to learn about emoji. See
 * `docs/decisions/app-and-console/custom-emoji.md`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { customEmojiNameFrom } from "@context/shared";

import type { SlackmojiResult } from "../files/emoji/host";
import { CustomEmojiContext, type CustomEmojiValue } from "./context";
import { dataUrlFor } from "../files/imageBytes";
import { AddEmojiDialog } from "./AddEmojiDialog";
import { forgetCustomEmoji, loadCustomEmoji } from "./emojiCache";

/** The server's own sentence for a failure, where there is one. */
export function failureMessage(failure: unknown, fallback: string): string {
  return (failure as { data?: { message?: string } })?.data?.message ?? fallback;
}

function failureCode(failure: unknown): string | undefined {
  return (failure as { data?: { code?: string } })?.data?.code;
}

interface DialogRequest {
  query: string;
  tab: "upload" | "slackmojis";
  resolve: (name: string | null) => void;
}

export function CustomEmojiProvider({
  workspaceId,
  canEdit,
  children,
}: {
  workspaceId: string | null;
  canEdit: boolean;
  children: ReactNode;
}) {
  const list = useAction(api.functions.emoji.list);
  const read = useAction(api.functions.emoji.read);
  const add = useAction(api.functions.emoji.add);
  const renameAction = useAction(api.functions.emoji.rename);
  const removeAction = useAction(api.functions.emoji.remove);
  const search = useAction(api.functions.emoji.searchSlackmojis);
  const preview = useAction(api.functions.emoji.slackmojiPreview);
  const importAction = useAction(api.functions.emoji.importSlackmoji);

  const [names, setNames] = useState<readonly string[] | null>(null);
  const [generation, setGeneration] = useState(0);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  /** The list in flight, so a `load` asked before it lands waits for it rather than guessing. */
  const listing = useRef<Promise<readonly string[] | null> | null>(null);

  const id = workspaceId as Id<"workspaces"> | null;

  const refresh = useCallback((): Promise<readonly string[] | null> => {
    if (id === null) return Promise.resolve(null);
    const pending = list({ workspaceId: id })
      .then((emoji) => emoji.map((entry) => entry.name))
      .catch(() => null);
    listing.current = pending;
    void pending.then((next) => {
      if (listing.current !== pending) return;
      setNames(next);
      setGeneration((value) => value + 1);
    });
    return pending;
  }, [id, list]);

  useEffect(() => {
    setNames(null);
    void refresh();
  }, [refresh]);

  const changed = useCallback(
    (name?: string) => {
      if (id !== null) forgetCustomEmoji(id, name);
      void refresh();
    },
    [id, refresh],
  );

  const value = useMemo((): CustomEmojiValue | null => {
    if (id === null) return null;
    const load = async (name: string): Promise<string | null> => {
      const known = await (listing.current ?? Promise.resolve(null));
      if (known !== null && !known.includes(name)) return null;
      return loadCustomEmoji(id, name, (args) => read({ workspaceId: id, ...args }));
    };
    const editing = canEdit
      ? {
          openAdd: (options: { query: string; tab: "upload" | "slackmojis" }) =>
            new Promise<string | null>((resolve) => setDialog({ ...options, resolve })),
          searchSlackmojis: (query: string) => search({ workspaceId: id, query }),
          previewSlackmoji: (url: string) =>
            preview({ workspaceId: id, url })
              .then((picture) => dataUrlFor(picture.bytes, picture.contentType))
              .catch(() => null),
          importSlackmoji: async (
            result: SlackmojiResult,
            wanted: string,
            options: { exact?: boolean; replace?: boolean } = {},
          ) => {
            const base = options.exact === true ? wanted : customEmojiNameFrom(wanted) || "emoji";
            const attempts = options.exact === true ? 1 : 5;
            for (let attempt = 1; attempt <= attempts; attempt += 1) {
              const name = attempt === 1 ? base : `${base}-${attempt}`;
              try {
                const added = await importAction({
                  workspaceId: id,
                  url: result.url,
                  name,
                  replace: options.replace === true,
                });
                changed(added.name);
                return { name: added.name };
              } catch (failure) {
                if (failureCode(failure) !== "DESTINATION_EXISTS" || attempt === attempts) {
                  return { error: failureMessage(failure, "That emoji could not be added.") };
                }
              }
            }
            return { error: "Every name like that is taken. Add it from the menu with a name of your own." };
          },
        }
      : {};
    return {
      generation,
      names,
      canEdit,
      custom: () => names,
      load,
      ...editing,
      rename: async (from, to) => {
        try {
          await renameAction({ workspaceId: id, from, to });
          forgetCustomEmoji(id, from);
          changed(to);
          return null;
        } catch (failure) {
          return failureMessage(failure, "That emoji could not be renamed.");
        }
      },
      remove: async (name) => {
        try {
          await removeAction({ workspaceId: id, name });
          changed(name);
          return null;
        } catch (failure) {
          return failureMessage(failure, "That emoji could not be removed.");
        }
      },
    };
  }, [id, canEdit, generation, names, read, search, preview, importAction, renameAction, removeAction, changed]);

  const close = (name: string | null) => {
    dialog?.resolve(name);
    setDialog(null);
  };

  return (
    <CustomEmojiContext.Provider value={value}>
      {children}
      {dialog !== null && id !== null && value !== null ? (
        <AddEmojiDialog
          initialQuery={dialog.query}
          initialTab={dialog.tab}
          taken={names ?? []}
          upload={async (name, bytes, replace) => {
            try {
              const added = await add({ workspaceId: id, name, bytes, replace });
              changed(added.name);
              return { name: added.name };
            } catch (failure) {
              return { error: failureMessage(failure, "That emoji could not be added."), code: failureCode(failure) };
            }
          }}
          host={value}
          onClose={close}
        />
      ) : null}
    </CustomEmojiContext.Provider>
  );
}
