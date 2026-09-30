/**
 * When an open project folder's notes are fetched (`mirrorFolder.ts`) — kept
 * out of React so the rule can be tested.
 *
 * A request is remembered, not dropped, when it cannot run yet. A phone opens
 * straight onto the page it was last on, before it knows it is online and
 * before the live list of contexts has landed, and a request that arrived then
 * and was thrown away left that List as stale as the device's copy was: the
 * fix for "the phone shows fewer projects" shipped and the phone still did.
 * So the last folder asked for in each context runs as soon as it can, and
 * again whenever the caller says to retry — coming online, the contexts
 * landing, the app returning to the foreground — because a page left open
 * all afternoon is exactly the one whose notes moved on.
 *
 * One run per context at a time; a request that lands during one runs once
 * more after it, for whichever folder was asked for last.
 */
export interface FolderFreshener {
  request(workspaceId: string, folder: string): void;
  /** Run every remembered request that can run now. */
  retry(): void;
}

export function folderFreshener(options: {
  /** False while offline, signed out, or the context is not in the live list. */
  ready: (workspaceId: string) => boolean;
  run: (workspaceId: string, folder: string) => Promise<unknown>;
}): FolderFreshener {
  const wanted = new Map<string, string>();
  /** Running contexts; true when another request came in meanwhile. */
  const running = new Map<string, boolean>();

  const attempt = (workspaceId: string) => {
    if (!wanted.has(workspaceId) || !options.ready(workspaceId)) return;
    if (running.has(workspaceId)) {
      running.set(workspaceId, true);
      return;
    }
    running.set(workspaceId, false);
    void (async () => {
      do {
        running.set(workspaceId, false);
        const folder = wanted.get(workspaceId);
        if (folder === undefined || !options.ready(workspaceId)) break;
        await options.run(workspaceId, folder).catch(() => {});
      } while (running.get(workspaceId) === true);
    })().finally(() => running.delete(workspaceId));
  };

  return {
    request(workspaceId, folder) {
      wanted.set(workspaceId, folder);
      attempt(workspaceId);
    },
    retry() {
      for (const workspaceId of [...wanted.keys()]) attempt(workspaceId);
    },
  };
}
