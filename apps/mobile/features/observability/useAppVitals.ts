import { useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { onVitals, returnVitals, takeVitals, vitalPlatform, vitalSession } from "./vitals";

/**
 * Sends the app's own vitals (`./vitals`) while someone is signed in. Mounted
 * once, by `FeedbackHost` in the signed-in layout. A send that fails is put
 * back and tried on the next vital or the next mount; the server keeps one of
 * each kind per session, so a repeat is harmless.
 */
export function useAppVitals(): void {
  const report = useMutation(api.functions.appVitals.report);
  useEffect(() => {
    let sending = false;
    const drain = async () => {
      if (sending) return;
      sending = true;
      try {
        for (let items = takeVitals(); items.length > 0; items = takeVitals()) {
          for (let i = 0; i < items.length; i += 1) {
            const item = items[i]!;
            try {
              await report({
                platform: vitalPlatform(),
                session: vitalSession(),
                kind: item.kind,
                ...(item.ms === undefined ? {} : { ms: item.ms }),
              });
            } catch {
              returnVitals(items.slice(i));
              return;
            }
          }
        }
      } finally {
        sending = false;
      }
    };
    void drain();
    return onVitals(() => void drain());
  }, [report]);
}
