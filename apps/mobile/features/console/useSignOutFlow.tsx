import { useCallback, useState } from "react";
import { useRouter } from "expo-router";
import { useAuthActions } from "@convex-dev/auth/react";
import { Confirm } from "./files/Dialogs";
import { forgetLocalCopies, unsentOnDevice } from "../offline/forget";
import { signOutWarning } from "../offline/copy";
import type { ConsoleData } from "./types";
import { resetObservabilityUser } from "../observability/client";

const NO_QUEUE = { pending: 0, conflicted: 0, rejected: 0 };

/**
 * Ending the session, from wherever it is asked for.
 *
 * The whole of this used to sit inline in the rail's account block, which was
 * the only control that could ask for it. Settings now carries a Sign out row
 * as well — a person searching for "sign out" lands there rather than on a
 * glyph they have to recognise — and two copies of a flow that decides whether
 * unsaved work is about to be discarded is two answers to that question.
 *
 * What the flow is, unchanged from where it lived:
 *
 *  - **The local cache is cleared first, and awaited.** A clear that merely
 *    started leaves a window the next sign-in can race. `forgetLocalCopies`
 *    ends the session epoch before it removes anything, and every writer in
 *    `useOfflineNotes` drops a write from a session that has ended.
 *  - **It cannot block.** Being unable to end a session is worse than a cache
 *    that outlives one, so the verdict is reported and never enforced, and the
 *    await is bounded inside `forget.ts`.
 *  - **The person is asked first when the queue is not empty**, over every
 *    context on the device rather than the one on screen, because that is what
 *    is about to go.
 *
 * The open context's queue is normally excluded from the device count and
 * supplied by the live hook instead, whose copy is newer than the persisted
 * one. That swap only holds once the hook has read the queue back: before
 * `ready` its counts are an *empty* queue rather than this device's, and
 * sign-out pressed during a cold load is not a corner — it is somebody who
 * opened the console to leave. Unready, nothing is excluded.
 *
 * `dialog` is rendered by the caller, once. The confirm is the console's own
 * `Confirm`, the same primitive a dirty tab close uses.
 */
export function useSignOutFlow(data: ConsoleData): {
  requestSignOut: () => void;
  dialog: React.ReactNode;
} {
  const router = useRouter();
  const { signOut } = useAuthActions();
  const [discarding, setDiscarding] = useState<string | null>(null);

  const signOutNow = useCallback(() => {
    void (async () => {
      await forgetLocalCopies();
      await signOut();
      resetObservabilityUser();
      router.replace("/");
    })();
  }, [router, signOut]);

  const live = data.files.sync;
  const selectedContextId = data.selectedContextId;
  const requestSignOut = useCallback(() => {
    void (async () => {
      const elsewhere = await unsentOnDevice(
        live?.ready === true ? selectedContextId : null,
      );
      const here = live?.counts ?? NO_QUEUE;
      const warning = signOutWarning({
        pending: here.pending + elsewhere.pending,
        conflicted: here.conflicted + elsewhere.conflicted,
        rejected: here.rejected + elsewhere.rejected,
      });
      if (warning === null) {
        signOutNow();
        return;
      }
      setDiscarding(warning);
    })();
  }, [live, selectedContextId, signOutNow]);

  return {
    requestSignOut,
    dialog:
      discarding === null ? null : (
        <Confirm
          title="Sign out with edits still waiting?"
          body={`${discarding} Nothing else is lost — your bucket is untouched.`}
          confirmLabel="Sign out and discard"
          onCancel={() => setDiscarding(null)}
          onConfirm={() => {
            setDiscarding(null);
            signOutNow();
          }}
        />
      ),
  };
}
