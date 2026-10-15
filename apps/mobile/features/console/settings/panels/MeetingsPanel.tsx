import { StyleSheet } from "react-native";

import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import { atName } from "../../format";
import { selectedContext, type ConsoleData } from "../../types";
/*
  Component and constants by their own paths rather than the meetings barrel:
  that barrel re-exports `useMeetingFlow`, which imports `expo-router`, and a
  navigator has no business in a settings panel. `destination.ts` and
  `DestinationSheet.tsx` are both free of it.
*/
import { ThisMachineCard } from "../../../meetings/components/ThisMachineCard";
import { useMeetingsSnapshot } from "../../../meetings/useMeetings";
import { loadedFolders } from "../../files/browser";
import { MeetingsDestination } from "./MeetingsDestination";
import { PanelHead } from "./PanelHead";
import {
  CALL_AUDIO_PICKER_SENTENCE,
  CALL_AUDIO_SENTENCE,
  MIC_ONLY_LINE,
} from "../../../meetings/disclosure";

/**
 * Meetings: recording on this Mac, and where the notes land.
 *
 * **The one panel of the four that is not a refusal on a workspace**, and the
 * reason is a rule rather than an oversight. A mailbox, a calendar and a chat
 * history belong to a person and cannot be attached to a shared bucket at all.
 * A meeting *note* is different: `features/meetings/destination.ts` offers the
 * context you are looking at as a real second choice, with its audience named
 * on the row. So a workspace has a true answer here — "meetings can land here,
 * and they do not by default" — where the other three have only a wall.
 *
 * What is still personal-only is **this Mac**. The machine card is a
 * machine-level thing, and the grant it draws was minted for whichever context
 * the control plane resolved rather than for whichever context the console
 * happens to be showing. Drawing it under a workspace's heading would let a
 * reader conclude that this laptop sends its recordings *there*, which is the
 * exact failure `destination.ts` exists to prevent, arriving through a
 * settings panel instead of through a record button.
 *
 * ## This pane is where the two questions live now
 *
 * There used to be a sheet in front of every recording that asked where the
 * meeting should go and offered the whole-call switch. It is gone — pressing
 * New meeting records — so both answers moved here, which is the trade the
 * owner asked for: *"no need to ask people it will just confuse them"*. The
 * folder is a per-context setting. The machine's own audio is not a setting at
 * all any more: it is always recorded (`CallAudio` below says why). The
 * sentence about what happens to the audio is said here too, once, instead of
 * in front of every conversation.
 */
export function MeetingsPanel({
  data,
  sectioned,
}: {
  data: ConsoleData;
  sectioned: boolean;
}) {
  const current = selectedContext(data);
  const personal = current?.kind === "personal";

  return (
    <>
      <PanelHead section="meetings" sectioned={sectioned}>
        Record on your Mac. The transcript becomes a note.
      </PanelHead>

      {personal ? <ThisMachineCard focus="meetings" /> : null}

      {/*
        A control, where there used to be a paragraph.

        This block read `The first offer is always your own workspace, in
        ${INBOX_FOLDER}` — a constant, interpolated into prose, with nothing
        beside it. Email, Calendar and Chat each let somebody choose where
        their captures land; meetings was the one that did not, and the
        docstring above defended that with the "asked every time" rule, which
        is about a different question. It still holds: the sheet asks before
        every recording. What is settable is the folder the first offer names.
      */}
      <MeetingsDestination
        workspaceId={current?.id ?? null}
        slug={atName(current?.slug ?? "this context")}
        kind={current?.kind ?? "personal"}
        role={current?.role}
        folder={current?.meetingsFolder}
        folders={loadedFolders(data.files.listings)}
      />

      <AudioLine />
    </>
  );
}

/**
 * What a recording keeps, said once, in one line.
 *
 * The machine's own audio is always recorded where a build can take it (the
 * owner's decision, 2026-10-01), so there is no switch to explain. The line
 * says that audio is never kept, and names the one thing a reader could not
 * guess: what a browser asks, or what is missing on headphones. The words
 * live in `features/meetings/disclosure.ts`, where tests read them.
 */
function AudioLine() {
  const styles = useThemedStyles(makeStyles);
  const capture = useMeetingsSnapshot().capture;

  if (!capture.systemAudio) {
    return (
      <Text variant="foot" style={styles.audio} testID="meetings-mic-only">
        {MIC_ONLY_LINE}
      </Text>
    );
  }

  return (
    <Text variant="foot" style={styles.audio} testID="meetings-call-audio">
      {capture.systemAudioNeedsPicker ? CALL_AUDIO_PICKER_SENTENCE : CALL_AUDIO_SENTENCE}
    </Text>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    audio: { marginTop: 12, maxWidth: 546 },
  });
