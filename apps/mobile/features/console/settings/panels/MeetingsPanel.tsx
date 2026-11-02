import { useEffect, useState } from "react";
import { Linking, StyleSheet } from "react-native";

import { Text } from "../../../design/components/Text";
import { TextLink } from "../../../design/components/TextLink";
import { useThemedStyles, type Colors } from "../../../design/theme";
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
import {
  MAC_APP_URL,
  STOP_ASKING_AFTER,
  askForCallAudioAgain,
  browserName,
  callAudioGivenUp,
  onCallAudioMemory,
  readCallAudioMemory,
} from "../../../meetings/capture";
import { loadedFolders } from "../../files/browser";
import { CloudTranscriptionSettings } from "./CloudTranscriptionSettings";
import { MeetingsDestination } from "./MeetingsDestination";
import { MeetingJoinSettings } from "./MeetingJoinSettings";
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

      {/* On the account, so it is here whichever workspace is open. */}
      {data.demo !== true ? <CloudTranscriptionSettings /> : null}

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

      {personal && data.demo !== true ? <MeetingJoinSettings connections={data.googleConnections} /> : null}

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
    <>
      {capture.systemAudioNeedsPicker ? <BrowserCallAudio /> : null}
      <Text variant="foot" style={styles.audio} testID="meetings-call-audio">
        {capture.systemAudioNeedsPicker ? CALL_AUDIO_PICKER_SENTENCE : CALL_AUDIO_SENTENCE}
      </Text>
    </>
  );
}

/**
 * Whether this browser has stopped being asked for the call's audio.
 *
 * After `STOP_ASKING_AFTER` shares in a row with no sound, meetings here start
 * with the microphone only (`callAudioMemory`, board m4, 2026-10-17). This is
 * the one place that state is visible with no meeting running, and Try again
 * puts the picker back for the next meeting. Nothing when the browser is fine.
 */
export function BrowserCallAudio() {
  const styles = useThemedStyles(makeStyles);
  const [memory, setMemory] = useState(readCallAudioMemory);
  useEffect(() => onCallAudioMemory(() => setMemory(readCallAudioMemory())), []);
  if (!callAudioGivenUp(memory)) return null;

  const browser = browserName();
  const times = STOP_ASKING_AFTER === 2 ? "two" : String(STOP_ASKING_AFTER);
  return (
    <Text variant="foot" style={styles.audio} testID="meetings-call-audio-given-up">
      <Text variant="foot" style={styles.crit}>
        {`Call audio isn't working in ${browser === "This browser" ? "this browser" : browser}.`}
      </Text>
      {` The last ${times} meetings recorded only your voice, so meetings here no longer ask. `}
      <TextLink
        label="Try again"
        onPress={askForCallAudioAgain}
        testID="meetings-call-audio-try-again"
      />
      {" · The "}
      <TextLink
        label="Mac app"
        onPress={() => void Linking.openURL(MAC_APP_URL).catch(() => {})}
        testID="meetings-call-audio-mac-app"
      />
      {" records both sides with no prompt."}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    audio: { marginTop: 12, maxWidth: 546 },
    crit: { color: colors.critText },
  });
