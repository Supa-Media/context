import { useCallback, useRef } from "react";
import { useRouter } from "expo-router";
import { showCarriedMeeting } from "./carried";
import { meetings, type ContinueInput } from "./controller";
import { meetingHref } from "./route";

/**
 * Pick a stopped meeting back up, and show the recording where meetings are
 * shown.
 *
 * One hook for every surface that offers Resume — the floating bar, the
 * meeting's own page, the console's panel and the note — so a press lands in
 * the same place from all of them: the console's panel when the console is
 * carrying meetings (`showCarriedMeeting`), the meeting's own page otherwise.
 *
 * One press, one part, for `useMeetingFlow`'s reason: a second press before
 * the first has opened the device would be a second recording of the same
 * conversation. The controller refuses the second too (`continueMeeting` asks
 * `mayResume`, and the first part is live by then); the ref is what stops the
 * press from reaching it at all.
 *
 * Answers whether a part started, so a surface can say something when one did
 * not rather than doing nothing twice.
 */
export function useResumeMeeting(): (input: ContinueInput) => Promise<boolean> {
  const router = useRouter();
  const busy = useRef(false);
  return useCallback(
    async (input: ContinueInput) => {
      if (busy.current) return false;
      busy.current = true;
      try {
        const id = await meetings.continueMeeting(input);
        if (id === null) return false;
        if (!showCarriedMeeting()) router.push(meetingHref(id));
        return true;
      } catch {
        return false;
      } finally {
        busy.current = false;
      }
    },
    [router],
  );
}
