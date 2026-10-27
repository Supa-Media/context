import { useEffect, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { observedUserId, onObservedUserChange } from "../../../observability/client";
import { applyAccountSpelling, setSpellingSaver } from "./store";

/**
 * Keeps the note editor's spelling settings following the account while
 * somebody is signed in — on or off, the language, and the words they added
 * (Dev2, 2026-10-27). Mounted once, at the root (`app/_layout.tsx`), beside
 * `useAccountAppearanceSync` and for the same reason: the choice is the
 * person's, not one screen's.
 *
 * Signed out, the device's own copy stands and "Add to dictionary" keeps the
 * word on this device only; nothing is lost, and nothing is sent.
 */
export function useSpellingSync(): void {
  const me = useSyncExternalStore(onObservedUserChange, observedUserId, observedUserId);
  const remote = useQuery(api.functions.spelling.mySpelling, me === null ? "skip" : {});
  const learn = useMutation(api.functions.spelling.learnSpellingWord);
  const forget = useMutation(api.functions.spelling.forgetSpellingWord);
  const set = useMutation(api.functions.spelling.setMySpelling);

  useEffect(() => {
    if (me === null) {
      setSpellingSaver(null);
      return;
    }
    setSpellingSaver({
      learn: (word) => learn({ word }),
      forget: (word) => forget({ word }),
      setEnabled: (enabled) => set({ enabled }),
      setLanguage: (language) => set({ language }),
    });
    return () => setSpellingSaver(null);
  }, [me, learn, forget, set]);

  useEffect(() => {
    // `null` is an account that never changed anything: the device's copy stands.
    if (me === null || remote === undefined || remote === null) return;
    applyAccountSpelling({ enabled: remote.enabled, language: remote.language, words: remote.words });
  }, [me, remote]);
}
