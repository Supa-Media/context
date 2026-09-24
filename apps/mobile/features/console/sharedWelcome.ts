import { atName } from "./format";
import type { ConsoleContext } from "./types";

/**
 * B2-02 — the welcome a person gets the first time they open a workspace
 * somebody invited them into.
 *
 * It is not a second notice. It is `contextIntro`'s band, drawn larger, on
 * the same condition and answered by the same per-context, per-kind flag:
 * that band is already "what this reader has not been told yet, shown until
 * it is answered", and the moment after accepting an invitation is exactly
 * when it is first drawn. Two bands for one moment is the stacking
 * `contextIntro.ts` was written to remove.
 *
 * So this only decides whether the band is drawn as the welcome, and what the
 * welcome offers:
 *
 *  - never on a phone, where the band keeps its one line and no control —
 *    `useBrowseNotices` argues why the phone cannot put it away;
 *  - never on the demo, whose band is its call to action;
 *  - never on the pinned `@context-lc`, which nobody was invited to;
 *  - never for the owner. An owner has an intro only when they cannot write
 *    (a read-only, cancelled workspace says so here), and "Welcome to" your
 *    own workspace over that sentence would be the wrong news entirely;
 *  - "Get a personal workspace of your own" only for somebody who has none,
 *    because offering a thing they already have is a way of saying we did not
 *    look.
 */
export interface SharedWelcome {
  /** "@dc-chapter". */
  handle: string;
  /** "Editor" / "Member", or the raw role for a vocabulary this does not know. */
  roleLabel: string;
  /** Whether to offer `/welcome` — false for anybody who owns a personal workspace. */
  offerPersonal: boolean;
}

export function sharedWelcome(view: {
  intro: { kind: string } | null;
  current: Pick<ConsoleContext, "slug" | "role"> | null | undefined;
  contexts: ReadonlyArray<Pick<ConsoleContext, "kind" | "role">>;
  demo: boolean;
  compact: boolean;
}): SharedWelcome | null {
  if (view.intro === null || view.intro.kind === "pinned") return null;
  if (view.demo || view.compact || !view.current || view.current.role === "owner") return null;
  return {
    handle: atName(view.current.slug),
    roleLabel: roleLabel(view.current.role),
    offerPersonal: !view.contexts.some(
      (context) => context.kind === "personal" && context.role === "owner",
    ),
  };
}

function roleLabel(role: string): string {
  switch (role) {
    case "editor":
      return "Editor";
    case "member":
      return "Member";
    default:
      return role;
  }
}
