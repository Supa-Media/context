import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { CLOUD_TRANSCRIPTION_CONSENT_VERSION } from "@context/shared";
import {
  cloudTranscriptionAllowed,
  forgetSpooledAudio,
  onTranscriptionConsentChange,
  setTranscriptionConsent,
  type RecorderCapability,
} from "./capture";
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

/** The account's answer, live. `undefined` while loading, `null` signed out. */
export function useTranscriptionConsentAnswer() {
  return useQuery(api.functions.transcriptionConsent.myTranscriptionConsent, {});
}

export function useTranscriptionConsentSync(): void {
  const answer = useTranscriptionConsentAnswer();
  useEffect(() => {
    if (answer === undefined || answer === null) {
      setTranscriptionConsent(null);
      return;
    }
    if (answer.allowed) {
      setTranscriptionConsent(answer.currentVersion);
      return;
    }
    setTranscriptionConsent(null);
    // A definite no: whatever audio is still on this device waiting to be
    // transcribed is never sent, including after a relaunch.
    forgetSpooledAudio();
  }, [answer]);
  // Unmounted is signed out or switched: no.
  useEffect(() => () => setTranscriptionConsent(null), []);
}

/** Whether cloud transcription is allowed on this device right now, live. */
export function useCloudTranscriptionAllowed(): boolean {
  return useSyncExternalStore(onTranscriptionConsentChange, cloudTranscriptionAllowed, cloudTranscriptionAllowed);
}

/** Whether starting with this recorder would send audio to the cloud without a yes. */
export function needsTranscriptionConsent(capture: RecorderCapability): boolean {
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
export function useTranscriptionConsentGate(options: { capture: RecorderCapability; visitor?: boolean }): {
  gate: (run: () => void) => void;
  sheet: ReactElement | null;
} {
  const { capture, visitor = false } = options;
  const allow = useMutation(api.functions.transcriptionConsent.allowTranscription);
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
        if (!visitor) await allow({ version: CLOUD_TRANSCRIPTION_CONSENT_VERSION });
        // Ahead of the live query, so the recorder this press starts sees it.
        setTranscriptionConsent(CLOUD_TRANSCRIPTION_CONSENT_VERSION);
        finish();
      } catch {
        setBusy(false);
        setFailed(CONSENT_NOT_SAVED);
      }
    })();
  }, [allow, finish, visitor]);

  const sheet = asking ? createElement(TranscriptionConsent, { onAllow, onDecline: finish, busy, failed }) : null;
  return { gate, sheet };
}
