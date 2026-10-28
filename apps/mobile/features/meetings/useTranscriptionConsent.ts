import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { CLOUD_TRANSCRIPTION_CONSENT_VERSION } from "@context/shared";
import {
  cloudTranscriptionAllowed,
  allowTranscriptionHere,
  forgetSpooledAudio,
  onTranscriptionConsentChange,
  setTranscriptionConsent,
  transcriptionWithdrawalConfirmed,
  withdrawTranscriptionHere,
  type RecorderCapability,
} from "./capture";
import {
  clearWithdrawal,
  consentAccount,
  knownPendingWithdrawal,
  readPendingWithdrawal,
  rememberWithdrawal,
  setConsentAccount,
} from "./transcriptionWithdrawal";
import { TranscriptionConsent } from "./components/TranscriptionConsent";

/**
 * Cloud transcription consent on this device
 * (`docs/decisions/meetings/transcription-consent.md`).
 *
 * Two hooks:
 *
 *  - `useTranscriptionConsentSync`, mounted once beside `useTranscriptionClient`
 *    in the signed-in layout: hands the account's live answer to the
 *    recorders, and the moment the answer is a definite no (a withdrawal, on
 *    this device or another) empties the spool of audio still waiting to be
 *    sent. Loading, signed out, or a version this build does not show are all
 *    no.
 *  - `useTranscriptionConsentGate`, wherever a meeting is started: puts the
 *    dialog in front of the start when the recorder would send audio to the
 *    cloud and there is no yes.
 */

/**
 * The account's answer, live. `undefined` while loading or skipped, `null`
 * signed out. `signedIn: false` subscribes to nothing, for the layout that
 * mounts before it knows.
 */
export function useTranscriptionConsentAnswer(signedIn = true) {
  return useQuery(api.functions.transcriptionConsent.myTranscriptionConsent, signedIn ? {} : "skip");
}

export function useTranscriptionConsentSync(signedIn = true): void {
  const answer = useTranscriptionConsentAnswer(signedIn);
  const convex = useConvex() as ReturnType<typeof useConvex> | undefined;
  const resent = useRef(new Set<string>());
  useEffect(() => {
    if (answer === undefined || answer === null) {
      setTranscriptionConsent(null);
      return;
    }
    const { account } = answer;
    setConsentAccount(account);
    if (!answer.allowed) {
      setTranscriptionConsent(null);
      // The account says no, so a Turn off made here has arrived.
      transcriptionWithdrawalConfirmed();
      void clearWithdrawal(account);
      // A definite no: whatever audio is still on this device waiting to be
      // transcribed is never sent, including after a relaunch.
      forgetSpooledAudio();
      return;
    }
    // A yes counts only once this device has checked it holds no Turn off for
    // this account that the account has not heard yet.
    const apply = (pending: boolean) => {
      if (!pending) {
        setTranscriptionConsent(answer.currentVersion);
        return;
      }
      withdrawTranscriptionHere();
      if (convex !== undefined && !resent.current.has(account)) {
        resent.current.add(account);
        void convex.mutation(api.functions.transcriptionConsent.withdrawTranscription, {}).catch(() => {});
      }
    };
    const known = knownPendingWithdrawal(account);
    if (known !== undefined) {
      apply(known);
      return;
    }
    setTranscriptionConsent(null);
    let live = true;
    void readPendingWithdrawal(account).then((pending) => {
      if (live) apply(pending);
    });
    return () => {
      live = false;
    };
  }, [answer, convex]);
  // Unmounted is signed out or switched: no.
  useEffect(
    () => () => {
      setTranscriptionConsent(null);
      setConsentAccount(null);
    },
    [],
  );
}

/** Whether cloud transcription is allowed on this device right now, live. */
export function useCloudTranscriptionAllowed(): boolean {
  return useSyncExternalStore(onTranscriptionConsentChange, cloudTranscriptionAllowed, cloudTranscriptionAllowed);
}

/** Whether starting with this recorder would send audio to the cloud without a yes. */
export function needsTranscriptionConsent(capture: Pick<RecorderCapability, "audio" | "transcribesAt">): boolean {
  return capture.audio && capture.transcribesAt === "cloud" && !cloudTranscriptionAllowed();
}

/** Said under the buttons when the yes could not be saved. */
export const CONSENT_NOT_SAVED = "That did not save, so nothing was recorded. Check your connection and try again.";

/**
 * The dialog in front of a start.
 *
 * `gate(run)` runs `run` at once when no question is needed. Otherwise it
 * shows the dialog: Allow saves the yes on the account (or, for a visitor on
 * the homepage, only for this tab: there is no account to keep it on) and
 * then runs; Not now runs too, and the recorder, finding no yes, opens no
 * microphone and the meeting is typed notes only.
 */
export function useTranscriptionConsentGate(options: {
  capture: Pick<RecorderCapability, "audio" | "transcribesAt">;
  visitor?: boolean;
  /** The signed-in account, when the caller has it; otherwise the one the layout last saw. */
  account?: string;
}): {
  gate: (run: () => void) => void;
  sheet: ReactElement | null;
} {
  const { capture, visitor = false, account } = options;
  // `useConvex` rather than `useMutation`: the homepage visitor saves nothing,
  // and a surface with no client must still be able to say Not now.
  const convex = useConvex() as ReturnType<typeof useConvex> | undefined;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const pending = useRef<(() => void) | null>(null);

  const gate = useCallback(
    (run: () => void) => {
      if (!needsTranscriptionConsent(capture)) {
        run();
        return;
      }
      pending.current = run;
      setFailed(null);
      setAsking(true);
    },
    [capture],
  );

  const finish = useCallback(() => {
    const run = pending.current;
    pending.current = null;
    setAsking(false);
    setBusy(false);
    run?.();
  }, []);

  const onAllow = useCallback(() => {
    setBusy(true);
    setFailed(null);
    void (async () => {
      try {
        if (!visitor) {
          if (convex === undefined) throw new Error("no Convex client");
          await convex.mutation(api.functions.transcriptionConsent.allowTranscription, {
            version: CLOUD_TRANSCRIPTION_CONSENT_VERSION,
          });
        }
        // Ahead of the live query, so the recorder this press starts sees it.
        allowTranscriptionHere(CLOUD_TRANSCRIPTION_CONSENT_VERSION);
        const whose = account ?? consentAccount();
        if (!visitor && whose !== null) void clearWithdrawal(whose);
        finish();
      } catch {
        setBusy(false);
        setFailed(CONSENT_NOT_SAVED);
      }
    })();
  }, [account, convex, finish, visitor]);

  const sheet = asking ? createElement(TranscriptionConsent, { onAllow, onDecline: finish, busy, failed }) : null;
  return { gate, sheet };
}

/** Turn off on this device, kept under the account until the account agrees. */
export function withdrawHereFor(account: string): void {
  withdrawTranscriptionHere();
  void rememberWithdrawal(account);
}
