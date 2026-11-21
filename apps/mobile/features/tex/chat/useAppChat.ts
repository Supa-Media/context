import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import type { GrantRefresh } from "../../agent/consoleGrantCache";
import { useConsoleGrant } from "../../agent/useConsoleGrant";
import { onReturnToApp } from "../../app/returnToApp";
import {
  EDIT_SENTENCE,
  REACT_SENTENCE,
  MAX_PICTURES,
  MAX_TEXT,
  UNREACHABLE_SENTENCE,
  UNSEND_SENTENCE,
  appChatEndpoint,
  editRequest,
  warmRequest,
  WARM_AGAIN_MS,
  isPending,
  mergeRows,
  pictureRequest,
  readChat,
  readPictureHead,
  readReact,
  readSend,
  readStopped,
  reactRequest,
  retryRequest,
  stopRequest,
  waitRequest,
  sendRequest,
  tapbackRequest,
  unsendRequest,
  type AppChatRow,
  type AskChoice,
  type ChatLine,
  type ChatRead,
  type PendingLine,
  type ReactionEmoji,
  type SendRead,
} from "./appChatGateway";
import { chatPoster, type ChatPoster } from "./appChatRequest";
import { STOPPED_TOAST } from "./appChatRun";
import {
  EMPTY,
  FAST_WINDOW_MS,
  RETRY_MS,
  TOAST_MS,
  texCountOf,
  type AppChatView,
  type State,
} from "./appChatView";

export type { AppChatView } from "./appChatView";
export { FAST_WINDOW_MS, RETRY_MS } from "./appChatView";
import { PictureCache, encodePictures, previewUrlOf, revokeUrl } from "./appChatPictures";
import {
  patchRow,
  previewUrlsInUse,
  replyRefFor,
  reactionsAfterTap,
  serverRowOf,
  withReactions,
} from "./appChatLines";

const TOO_LONG_SENTENCE = `A text can be up to ${MAX_TEXT} characters. Shorten it and try again.`;
const TOO_MANY_SENTENCE = `You can send up to ${MAX_PICTURES} pictures at once.`;
const PICTURES_UNSUPPORTED_SENTENCE = "Pictures cannot be sent from this device yet.";
const PICTURE_TOO_LARGE_SENTENCE = "A picture could not be made small enough to send. Try a smaller one.";
const EDIT_EMPTY_SENTENCE = "A text cannot be empty. Nothing changed.";



/**
 * The chat with Tex, as the console shows it.
 *
 * The grant is the approvals' (`useConsoleGrant`), and a refused token is
 * replaced once, never in a loop (`appChatRequest.ts`). The chat is read with
 * one request held open (`wait`), answered as soon as anything in the chat
 * changes; not while the page is hidden. Each workspace and mount is an epoch: answers
 * from an earlier one are dropped, and picture and preview URLs are revoked.
 */
export function useAppChat(options: {
  /** The person's own personal workspace, or `null` before it is known. */
  workspaceId: string | null;
  /** The MCP endpoint the console already shows. */
  endpoint: string | null;
  /** False where there is nothing to ask about. */
  enabled: boolean;
}): AppChatView {
  const mint = useConsoleGrant();
  const route = options.endpoint === null ? null : appChatEndpoint(options.endpoint);
  const workspaceId = options.workspaceId;
  const live = options.enabled && route !== null && workspaceId !== null;
  const [state, setState] = useState<State>(EMPTY);
  const [pictures] = useState(() => new PictureCache());

  // Read by the timers and the callbacks, which must not wait for a render.
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);

  const epoch = useRef(0);
  const listing = useRef(0);
  const localSeq = useRef(0);
  const answering = useRef(new Set<string>());
  const typingSince = useRef<number | null>(null);
  const waitingNow = useRef<{ texCount: number } | null>(null);
  const giveUp = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const kick = useRef<() => void>(() => {});
  /** The blobs and reply of each send still pending, so a failed one can be sent again. */
  const parked = useRef(new Map<string, { blobs: Blob[]; replyTo: string | null }>());
  /** Preview URLs made for pending pictures and not yet revoked. */
  const previews = useRef(new Set<string>());

  const poster = useMemo<ChatPoster | null>(
    () =>
      route === null || workspaceId === null
        ? null
        : chatPoster({
            route,
            mint: (refresh: GrantRefresh) =>
              mint({ workspaceId: workspaceId as Id<"workspaces"> }, refresh).then((minted) => minted.accessToken),
          }),
    [mint, route, workspaceId],
  );
  // The effects below call the latest poster without re-running on every change
  // of the grant's identity, the same trick `useApprovals` uses.
  const posterRef = useRef(poster);
  useEffect(() => {
    posterRef.current = poster;
  }, [poster]);
  const ask = useCallback<ChatPoster>(
    (body, as) => (posterRef.current === null ? Promise.resolve(null) : posterRef.current(body, as)),
    [],
  );

  const bump = useCallback(() => setState((s) => ({ ...s })), []);

  const dropPreviews = () => {
    for (const url of previews.current) revokeUrl(url);
    previews.current.clear();
  };

  /** A turn the person opened: fast polling until Tex answers, and given up after `FAST_WINDOW_MS`. */
  const openTurn = useCallback((lines: readonly ChatLine[]) => {
    const mine = { texCount: texCountOf(lines) };
    waitingNow.current = mine;
    setState((s) => ({ ...s, waiting: mine }));
    clearTimeout(giveUp.current);
    giveUp.current = setTimeout(() => {
      if (waitingNow.current === mine) waitingNow.current = null;
      setState((s) => (s.waiting === mine ? { ...s, waiting: null } : s));
    }, FAST_WINDOW_MS);
  }, []);

  // A preview is revoked once no pending line shows it: replaced by the server's row, or removed.
  useEffect(() => {
    const inUse = previewUrlsInUse(state.lines);
    for (const url of [...previews.current]) {
      if (inUse.has(url)) continue;
      revokeUrl(url);
      previews.current.delete(url);
    }
  }, [state.lines]);

  // Everything that depends on the scope: the poll, its timers, and the epoch.
  const scope = live ? `${workspaceId}\n${route}` : null;
  useEffect(() => {
    epoch.current += 1;
    const mark = epoch.current;
    typingSince.current = null;
    waitingNow.current = null;
    clearTimeout(giveUp.current);
    setState(EMPTY);
    if (scope === null) {
      return () => {
        epoch.current += 1;
        pictures.clear();
        dropPreviews();
      };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    /** The outbox digest the last read answered: the next `wait` is held until it changes (`appChatRoute.js`). */
    let since: string | null = null;
    let inFlight = false;

    // One timer at a time: a new schedule replaces the one waiting, so a kick
    // during a read cannot start a second chain.
    const schedule = (delay: number) => {
      if (stopped) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void run(), delay);
    };

    // One request held open at a time (`wait`): it answers as soon as the chat changes, or after 20 s with nothing new,
    // and the next is asked at once. After a failed read the chat is read again in `RETRY_MS`.
    const run = async (): Promise<void> => {
      timer = undefined;
      if (stopped || mark !== epoch.current || inFlight) return;
      // Paused while hidden. The return listener restarts it.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      inFlight = true;
      const mine = ++listing.current;
      const answer = await ask(waitRequest(since));
      inFlight = false;
      if (stopped || mark !== epoch.current) return;
      if (mine !== listing.current) return schedule(0);
      const read: ChatRead =
        answer === null ? { kind: "failed", sentence: UNREACHABLE_SENTENCE } : readChat(answer.status, answer.body);
      if (read.kind === "listed") {
        since = read.digest;
        if (read.typing && typingSince.current === null) typingSince.current = Date.now();
        if (!read.typing) typingSince.current = null;
        setState((s) => {
          const lines = mergeRows(s.lines, read.rows);
          const waiting = s.waiting !== null && texCountOf(lines) > s.waiting.texCount ? null : s.waiting;
          if (waiting === null) waitingNow.current = null;
          return { ...s, phase: "listed", lines, typing: read.typing, run: read.run, loadError: null, waiting };
        });
        // A route that cannot hold a read (no digest) is read again after a pause, never in a tight loop.
        schedule(read.digest === null ? RETRY_MS : 0);
      } else {
        since = null;
        setState((s) => ({ ...s, phase: s.phase === "idle" ? "failed" : s.phase, loadError: read.sentence }));
        schedule(RETRY_MS);
      }
    };

    // A change of the person's own (a send, a tapback): read now, not held, when no read is open.
    kick.current = () => {
      since = null;
      if (!inFlight) schedule(0);
    };
    const stopReturn = onReturnToApp(() => schedule(0), ["focus", "visibilitychange"]);
    schedule(0);

    return () => {
      stopped = true;
      epoch.current += 1;
      if (timer !== undefined) clearTimeout(timer);
      clearTimeout(giveUp.current);
      kick.current = () => {};
      stopReturn();
      pictures.clear();
      dropPreviews();
    };
  }, [scope]);

  /** One send of a pending line already on the page: pictures shrunk and encoded first, then the route. */
  const dispatchSend = useCallback(
    (localId: string, text: string, blobs: readonly Blob[], replyId: string | null) => {
      const mark = epoch.current;
      setState((s) => ({
        ...s,
        error: null,
        sendsInFlight: s.sendsInFlight + 1,
        lines: s.lines.map((line) => (isPending(line) && line.localId === localId ? { ...line, state: "sending" } : line)),
      }));
      void (async () => {
        const encoded = blobs.length > 0 ? await encodePictures(blobs) : [];
        const request = encoded === null ? null : sendRequest(text, { pictures: encoded, replyTo: replyId });
        const reply = request === null ? null : await ask(request);
        if (mark !== epoch.current) return;
        const read: SendRead =
          encoded === null
            ? { kind: "failed", sentence: PICTURE_TOO_LARGE_SENTENCE }
            : request === null
              ? { kind: "failed", sentence: TOO_LONG_SENTENCE }
              : reply === null
                ? { kind: "failed", sentence: UNREACHABLE_SENTENCE }
                : readSend(reply.status, reply.body);
        if (read.kind === "sent") {
          parked.current.delete(localId);
          setState((s) => ({
            ...s,
            sendsInFlight: s.sendsInFlight - 1,
            error: null,
            // The id the next read replaces this line by.
            lines: s.lines.map((line) => (isPending(line) && line.localId === localId ? { ...line, msgId: read.msgId } : line)),
          }));
          openTurn(latest.current.lines);
          kick.current();
        } else {
          setState((s) => ({
            ...s,
            sendsInFlight: s.sendsInFlight - 1,
            error: read.sentence,
            lines: s.lines.map((line) => (isPending(line) && line.localId === localId ? { ...line, state: "failed" } : line)),
          }));
        }
      })();
    },
    [ask, openTurn],
  );

  const send = useCallback(
    (text: string, options: { pictures?: readonly Blob[]; replyTo?: string | null } = {}) => {
      if (!live) return;
      const trimmed = text.trim();
      const blobs = [...(options.pictures ?? [])];
      const refuse = (sentence: string) => setState((s) => ({ ...s, error: sentence }));
      if (trimmed.length === 0 && blobs.length === 0) return;
      if (trimmed.length > MAX_TEXT) return refuse(TOO_LONG_SENTENCE);
      if (blobs.length > MAX_PICTURES) return refuse(TOO_MANY_SENTENCE);
      const urls: string[] = [];
      for (const blob of blobs) {
        const url = previewUrlOf(blob);
        if (url === null) {
          urls.forEach(revokeUrl);
          return refuse(PICTURES_UNSUPPORTED_SENTENCE);
        }
        urls.push(url);
      }
      localSeq.current += 1;
      const localId = `local-${localSeq.current}`;
      const replyId = options.replyTo ?? null;
      for (const url of urls) previews.current.add(url);
      parked.current.set(localId, { blobs, replyTo: replyId });
      const line: PendingLine = {
        pending: true,
        localId,
        who: "me",
        text: trimmed,
        at: Date.now(),
        state: "sending",
        ...(urls.length > 0 ? { previews: urls } : {}),
        ...(replyId !== null ? { replyTo: replyRefFor(latest.current.lines, replyId) } : {}),
      };
      setState((s) => ({ ...s, lines: [...s.lines, line] }));
      dispatchSend(localId, trimmed, blobs, replyId);
    },
    [dispatchSend, live],
  );

  const retry = useCallback(
    (localId: string) => {
      const line = latest.current.lines.find((item) => isPending(item) && item.localId === localId);
      if (line === undefined || !isPending(line)) return;
      const kept = parked.current.get(localId);
      dispatchSend(localId, line.text, kept?.blobs ?? [], kept?.replyTo ?? line.replyTo?.id ?? null);
    },
    [dispatchSend],
  );

  const answer = useCallback(
    (rowId: string, choice: AskChoice) => {
      if (!live || answering.current.has(rowId)) return;
      const row = serverRowOf(latest.current.lines, rowId);
      // Only Tex's text with an open ask can be answered. The gateway checks it again.
      if (row === undefined || row.who !== "tex" || row.ask?.open !== true) return;
      answering.current.add(rowId);
      const mark = epoch.current;
      setState((s) => ({ ...s, error: null, answers: { ...s.answers, [rowId]: choice } }));
      void ask(reactRequest(rowId, choice)).then((reply) => {
        answering.current.delete(rowId);
        if (mark !== epoch.current) return;
        const read = reply === null ? { kind: "failed" as const, sentence: UNREACHABLE_SENTENCE } : readReact(reply.status, reply.body);
        if (read.kind === "reacted") {
          openTurn(latest.current.lines);
          kick.current();
        } else {
          setState((s) => {
            const rest: Record<string, AskChoice> = { ...s.answers };
            delete rest[rowId];
            return { ...s, answers: rest, error: read.sentence };
          });
        }
      });
    },
    [ask, live, openTurn],
  );

  /** A change shown at once, the request sent, and the change undone when the route refuses it. */
  const changeRow = useCallback(
    (
      rowId: string,
      change: (row: AppChatRow) => AppChatRow,
      undo: (row: AppChatRow) => AppChatRow,
      body: unknown,
      fallback: string,
      onDone?: () => void,
    ) => {
      const mark = epoch.current;
      setState((s) => ({ ...s, error: null, lines: patchRow(s.lines, rowId, change) }));
      void ask(body).then((reply) => {
        if (mark !== epoch.current) return;
        const read = reply === null ? { kind: "failed" as const, sentence: UNREACHABLE_SENTENCE } : readReact(reply.status, reply.body, fallback);
        if (read.kind === "reacted") {
          onDone?.();
        } else {
          setState((s) => ({ ...s, error: read.sentence, lines: patchRow(s.lines, rowId, undo) }));
        }
      });
    },
    [ask],
  );

  const react = useCallback(
    (rowId: string, emoji: ReactionEmoji) => {
      if (!live) return;
      const row = serverRowOf(latest.current.lines, rowId);
      if (row === undefined) return;
      // A 👍 or 👎 on an open ask is the answer to it, with the same polling and record.
      if (row.who === "tex" && row.ask?.open === true && (emoji === "👍" || emoji === "👎")) {
        answer(rowId, emoji === "👍" ? "approve" : "deny");
        return;
      }
      const before = row.reactions;
      changeRow(
        rowId,
        (r) => withReactions(r, reactionsAfterTap(r, emoji)),
        (r) => withReactions(r, before),
        tapbackRequest(rowId, emoji),
        REACT_SENTENCE,
        // Read again at once: a poll that landed between the change and the answer would otherwise hide it for 10 s.
        () => kick.current(),
      );
    },
    [answer, changeRow, live],
  );

  const edit = useCallback(
    (rowId: string, text: string) => {
      if (!live) return;
      const row = serverRowOf(latest.current.lines, rowId);
      if (row === undefined || row.who !== "me" || row.editable !== true) return;
      const request = editRequest(rowId, text);
      if (request === null) {
        setState((s) => ({ ...s, error: EDIT_EMPTY_SENTENCE }));
        return;
      }
      changeRow(
        rowId,
        (r) => ({ ...r, text: request.text, edited: true }),
        () => row,
        request,
        EDIT_SENTENCE,
        // An edit can start a turn: Tex may answer the new words.
        () => {
          openTurn(latest.current.lines);
          kick.current();
        },
      );
    },
    [changeRow, live, openTurn],
  );

  const unsend = useCallback(
    (rowId: string) => {
      if (!live) return;
      const row = serverRowOf(latest.current.lines, rowId);
      if (row === undefined || row.who !== "me" || (row.unsendable !== true && row.editable !== true)) return;
      changeRow(
        rowId,
        (r) => {
          const next: AppChatRow = { ...r, text: "", unsent: true };
          delete next.pics;
          delete next.editable;
          delete next.unsendable;
          return next;
        },
        () => row,
        unsendRequest(rowId),
        UNSEND_SENTENCE,
      );
    },
    [changeRow, live],
  );

  const pictureUrl = useCallback(
    (id: string): string | null => {
      if (!live) return null;
      pictures.request(
        id,
        async () => {
          const answer = await ask(pictureRequest(id), "blob");
          if (answer === null) return null;
          const head = readPictureHead(answer.status, answer.contentType);
          return head.kind === "image" && typeof Blob !== "undefined" && answer.body instanceof Blob ? answer.body : null;
        },
        bump,
      );
      return pictures.lookup(id);
    },
    [ask, bump, live, pictures],
  );

  // The chat opened, or the person started typing: the model's cache is warmed for their next text (node `warm`). Never shown.
  const warmedAt = useRef(0);
  const warm = useCallback(
    (cause: "open" | "typing") => {
      if (!live || Date.now() - warmedAt.current < WARM_AGAIN_MS) return;
      warmedAt.current = Date.now();
      void ask(warmRequest(cause)).catch(() => null);
    },
    [ask, live],
  );
  useEffect(() => {
    if (live) warm("open");
  }, [live, warm]);
  const typing = useCallback(() => warm("typing"), [warm]);

  // The stop key and Esc: the running turn is cancelled, what it did stays, and a toast says so (mock).
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const stop = useCallback(() => {
    if (!live) return;
    const mark = epoch.current;
    void ask(stopRequest()).then((reply) => {
      if (mark !== epoch.current) return;
      if (reply !== null && readStopped(reply.status, reply.body)) {
        waitingNow.current = null;
        clearTimeout(giveUp.current);
        setState((s) => ({ ...s, toast: STOPPED_TOAST, waiting: null }));
        clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setState((s) => (s.toast === STOPPED_TOAST ? { ...s, toast: null } : s)), TOAST_MS);
      } else if (reply === null) {
        setState((s) => ({ ...s, error: UNREACHABLE_SENTENCE }));
      }
      kick.current();
    });
  }, [ask, live]);

  // Try again on a text Tex didn't answer (or one the person stopped): queued again as it came.
  const retryRow = useCallback(
    (rowId: string) => {
      if (!live) return;
      const row = serverRowOf(latest.current.lines, rowId);
      if (row === undefined || row.who !== "me" || (row.state !== "failed" && row.state !== "stopped")) return;
      changeRow(rowId, (r) => ({ ...r, state: "sent" }), () => row, retryRequest(rowId), UNREACHABLE_SENTENCE, () => {
        openTurn(latest.current.lines);
        kick.current();
      });
    },
    [changeRow, live, openTurn],
  );

  return useMemo<AppChatView>(
    () => ({
      available: live,
      phase: state.phase,
      lines: state.lines,
      busy: state.typing || state.waiting !== null || state.run !== null,
      sending: state.sendsInFlight > 0,
      error: state.loadError ?? state.error,
      answers: state.answers,
      send,
      retry,
      answer,
      react,
      edit,
      unsend,
      pictureUrl,
      typing,
      run: state.run,
      stop,
      retryRow,
      toast: state.toast,
    }),
    [answer, edit, live, pictureUrl, react, retry, retryRow, send, state, stop, typing, unsend],
  );
}
