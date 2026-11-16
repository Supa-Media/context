import { useCallback, useState } from "react";
import { useRouter } from "expo-router";
import { useAuthActions } from "@convex-dev/auth/react";
import { Confirm } from "./files/Dialogs";
import { forgetLocalCopies, unsentMeetingAudio, unsentOnDevice } from "../offline/forget";
import { signOutWarning } from "../offline/copy";
import type { ConsoleData } from "./types";
import { resetObservabilityUser, trackButton } from "../observability/client";

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
  requestSignOutEverywhere: (signOutEveryDevice: () => Promise<unknown>) => Promise<void>;
  dialog: React.ReactNode;
} {
  const router = useRouter();
  const { signOut } = useAuthActions();
  const [discarding, setDiscarding] = useState<Discarding | null>(null);

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
  const warningNow = useCallback(async () => {
    const elsewhere = await unsentOnDevice(
      live?.ready === true ? selectedContextId : null,
    );
    const here = live?.counts ?? NO_QUEUE;
    return signOutWarning(
      {
        pending: here.pending + elsewhere.pending,
        conflicted: here.conflicted + elsewhere.conflicted,
        rejected: here.rejected + elsewhere.rejected,
      },
      unsentMeetingAudio(),
    );
  }, [live, selectedContextId]);

  const requestSignOut = useCallback(() => {
    trackButton("sign_out");
    void (async () => {
      const warning = await warningNow();
      if (warning === null) {
        signOutNow();
        return;
      }
      setDiscarding({ warning, everywhere: false, proceed: signOutNow, cancel: () => undefined });
    })();
  }, [warningNow, signOutNow]);

  /*
    Sign out of every device, this one included (Dev2, 2026-11-16). The
    question about unsent work comes first, while this session can still
    answer it; the server then ends every session of the account in one
    transaction (after "Check it's you", which the Convex client asks for and
    retries on its own); only once it has does this device clear its copy and
    leave. A refusal rejects the returned promise, so the button that asked
    can say why, and nothing on this device has been cleared. Cancelling the
    question resolves it with nothing done.
  */
  const requestSignOutEverywhere = useCallback(
    (signOutEveryDevice: () => Promise<unknown>) =>
      new Promise<void>((resolve, reject) => {
        trackButton("sign_out_everywhere");
        const proceed = () => {
          void (async () => {
            try {
              await signOutEveryDevice();
            } catch (failure) {
              reject(failure);
              return;
            }
            resolve();
            signOutNow();
          })();
        };
        void (async () => {
          const warning = await warningNow();
          if (warning === null) {
            proceed();
            return;
          }
          setDiscarding({ warning, everywhere: true, proceed, cancel: resolve });
        })();
      }),
    [warningNow, signOutNow],
  );

  return {
    requestSignOut,
    requestSignOutEverywhere,
    dialog:
      discarding === null ? null : (
        <Confirm
          title={
            discarding.everywhere
              ? "Sign out everywhere with work still on this device?"
              : "Sign out with work still on this device?"
          }
          body={`${discarding.warning} Your bucket is untouched.`}
          confirmLabel={discarding.everywhere ? "Sign out everywhere and discard" : "Sign out and discard"}
          onCancel={() => {
            setDiscarding(null);
            discarding.cancel();
          }}
          onConfirm={() => {
            setDiscarding(null);
            discarding.proceed();
          }}
        />
      ),
  };
}

type Discarding = {
  warning: string;
  everywhere: boolean;
  proceed: () => void;
  cancel: () => void;
};
