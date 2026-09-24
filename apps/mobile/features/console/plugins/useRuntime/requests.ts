import { PREVIEW_LINKS_MAX } from "@context/obsidian-runtime";
import type { LinkPreview } from "../sandboxTypes";
import type { PluginGrant } from "../grants";
import {
  COMMAND_TIMEOUT_MS,
  PREVIEW_TIMEOUT_MS,
  SUGGEST_TIMEOUT_MS,
  currentWalk,
  maySeeContent,
  type ActiveSandbox,
  type CommandOutcome,
  type InvokeRequest,
  type PendingCommand,
  type PreviewRequest,
  type SuggestRequest,
} from "../runtime";
import type {
  ApplyWaiting,
  CommandTimers,
  FrameOwner,
  PreviewWaiting,
  Ref,
  Setter,
  SuggestWaiting,
} from "./cells";

/*
  The requests `useRuntime` sends to running frames: a command, a completion
  walk, a pick, and a preview walk. Each is the body of one of that hook's
  `useCallback`s, moved verbatim with its comment; the hook keeps the callback
  and its dependency list, and hands in what the body reads from the render.
*/

/*
  Ask a running plugin to run one of its commands.

  Synchronous and fire-and-forget: this only moves a slot, and the frame posts
  the message from an effect. The answer comes back as `command-result` and
  lands in `outcomes`, so a caller awaits nothing — there is no promise here
  that could resolve, because the guest may simply never answer and a hung
  command must not look like a pending one for ever.
*/
export function pressCommand(
  {
    isOwner,
    sandboxes,
    presses,
    commandTimers,
    setInvoke,
    setOutcomes,
    setPending,
  }: {
    isOwner: boolean;
    sandboxes: ActiveSandbox[];
    presses: Ref<number>;
    commandTimers: Ref<CommandTimers>;
    setInvoke: Setter<InvokeRequest | undefined>;
    setOutcomes: Setter<Record<string, CommandOutcome>>;
    setPending: Setter<Record<string, PendingCommand>>;
  },
  pluginId: string,
  id: string,
): void {
  if (!isOwner) return;
  /*
    Addressed to the frame that is running right now. A press for a plugin
    with no live frame is dropped here rather than sitting in the slot waiting
    for one to appear — see `invokeFor` for why a later frame must not inherit
    it.
  */
  const frame = sandboxes.find((one) => one.bundle.pluginId === pluginId);
  if (frame === undefined) return;
  presses.current += 1;
  const seq = presses.current;
  setInvoke({ seq, pluginId, nonce: frame.nonce, id });
  setOutcomes((was) => {
    if (!(pluginId in was)) return was;
    const next = { ...was };
    delete next[pluginId];
    return next;
  });
  setPending((was) => ({ ...was, [pluginId]: { id, seq } }));
  /*
    One timer per plugin, replacing any previous one: a second press
    supersedes the first, and the first's clock must not fire a "nothing
    answered" over the second's result.
  */
  const running = commandTimers.current.get(pluginId);
  if (running !== undefined) clearTimeout(running);
  commandTimers.current.set(
    pluginId,
    setTimeout(() => {
      commandTimers.current.delete(pluginId);
      setPending((was) => {
        // Only if this press is still the one outstanding.
        if (was[pluginId]?.seq !== seq) return was;
        const next = { ...was };
        delete next[pluginId];
        return next;
      });
      setOutcomes((was) => ({
        ...was,
        // `error: null` on purpose — nothing reported anything, and the card
        // must not say the plugin did. See `CommandOutcome.timedOut`.
        [pluginId]: { id, ok: false, error: null, timedOut: true },
      }));
    }, COMMAND_TIMEOUT_MS),
  );
}

/**
 * Ask the plugins whether any of them wants to complete this line.
 *
 * **First non-empty answer wins**, which is what the guest does too: its
 * loop returns on the first suggester whose `onTrigger` matches, exactly as
 * Obsidian's does. So the frames are asked in order and the first that
 * offers anything owns the menu — and owns the pick, which is what makes
 * `applySuggestion` unambiguous.
 *
 * Only frames that pass `maySeeContent` are asked at all. The line is note
 * content, and that gate is `vault:read` alone.
 */
export async function askFramesForSuggestions(
  {
    isOwner,
    sandboxes,
    grants,
    walk,
    suggestSeq,
    lastAsked,
    waiting,
    setSuggest,
  }: {
    isOwner: boolean;
    sandboxes: ActiveSandbox[];
    grants: readonly PluginGrant[] | undefined;
    walk: Ref<number>;
    suggestSeq: Ref<number>;
    lastAsked: Ref<number | null>;
    waiting: Ref<SuggestWaiting>;
    setSuggest: Setter<SuggestRequest | undefined>;
  },
  line: string,
  ch: number,
): Promise<{ text: string }[]> {
  if (!isOwner) return [];
  walk.current += 1;
  const mine = walk.current;
  for (const frame of sandboxes) {
    if (!currentWalk(mine, walk.current)) return [];
    if (!maySeeContent(frame.bundle, grants)) continue;
    suggestSeq.current += 1;
    const seq = suggestSeq.current;
    lastAsked.current = seq;
    const answer = new Promise<{ text: string }[]>((resolve) => {
      const timer = setTimeout(() => {
        waiting.current.delete(seq);
        resolve([]);
      }, SUGGEST_TIMEOUT_MS);
      waiting.current.set(seq, { resolve, timer });
    });
    setSuggest({ seq, pluginId: frame.bundle.pluginId, nonce: frame.nonce, line, ch });
    const items = await answer;
    if (!currentWalk(mine, walk.current)) return [];
    if (items.length > 0) return items;
  }
  return [];
}

/**
 * Ask the plugins to preview the open note's links.
 *
 * **Every frame is asked, and the answers are merged** — which is the one
 * place this deliberately differs from `askSuggestions`. A completion menu
 * has to belong to one plugin, because a pick has to be routed back to
 * whoever computed it; a preview is a finished string per link, so two
 * plugins previewing different links in the same note is a note where both
 * work rather than a conflict.
 *
 * Where two do claim the same link the first frame wins, for the same reason
 * the first suggester does: the order is the order they were started in, and
 * silently showing the second plugin's words under the first plugin's link
 * would be a worse answer than a stable one.
 *
 * Only frames that pass `maySeeContent` are asked. A link is note content —
 * the address somebody wrote down and the words they wrote around it.
 */
export async function askFramesForPreviews(
  {
    isOwner,
    sandboxes,
    grants,
    previewWalk,
    previewSeq,
    lastPreviewAsked,
    previewing,
    setPreview,
  }: {
    isOwner: boolean;
    sandboxes: ActiveSandbox[];
    grants: readonly PluginGrant[] | undefined;
    previewWalk: Ref<number>;
    previewSeq: Ref<number>;
    lastPreviewAsked: Ref<number | null>;
    previewing: Ref<PreviewWaiting>;
    setPreview: Setter<PreviewRequest | undefined>;
  },
  links: LinkPreview[],
): Promise<LinkPreview[]> {
  if (!isOwner || links.length === 0) return [];
  previewWalk.current += 1;
  const mine = previewWalk.current;
  const byHref = new Map<string, string>();
  for (const frame of sandboxes) {
    if (!currentWalk(mine, previewWalk.current)) return [];
    if (!maySeeContent(frame.bundle, grants)) continue;
    previewSeq.current += 1;
    const seq = previewSeq.current;
    lastPreviewAsked.current = seq;
    const answer = new Promise<LinkPreview[]>((resolve) => {
      const timer = setTimeout(() => {
        previewing.current.delete(seq);
        resolve([]);
      }, PREVIEW_TIMEOUT_MS);
      previewing.current.set(seq, { resolve, timer });
    });
    setPreview({
      seq,
      pluginId: frame.bundle.pluginId,
      nonce: frame.nonce,
      links: links.slice(0, PREVIEW_LINKS_MAX),
    });
    const previews = await answer;
    if (!currentWalk(mine, previewWalk.current)) return [];
    for (const one of previews) {
      if (one.text === "" || byHref.has(one.href)) continue;
      byHref.set(one.href, one.text);
    }
  }
  return [...byHref].map(([href, text]) => ({ href, text }));
}

/**
 * Take the suggestion somebody picked, and return the line it produced.
 *
 * Routed to the frame that offered the menu rather than to the plugin, for
 * #533's reason: a restart registers the same things, and a pick aimed at a
 * frame that has gone is not owed to its successor. Null when nothing
 * answers, so the editor leaves the line alone rather than clearing it.
 */
export async function applyOfferedSuggestion(
  {
    offeredBy,
    suggestSeq,
    applying,
    setSuggestApply,
  }: {
    offeredBy: Ref<FrameOwner>;
    suggestSeq: Ref<number>;
    applying: Ref<ApplyWaiting>;
    setSuggestApply: Setter<
      { seq: number; pluginId: string; nonce: string; index: number } | undefined
    >;
  },
  index: number,
): Promise<string | null> {
  const offer = offeredBy.current;
  if (offer === null) return null;
  suggestSeq.current += 1;
  const seq = suggestSeq.current;
  const answer = new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      applying.current.delete(seq);
      resolve(null);
    }, SUGGEST_TIMEOUT_MS);
    applying.current.set(seq, { resolve, timer });
  });
  setSuggestApply({ seq, pluginId: offer.pluginId, nonce: offer.nonce, index });
  return answer;
}
