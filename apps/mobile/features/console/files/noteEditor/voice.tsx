import { VoiceButton } from "../../../voice/VoiceButton";
import type { VoiceHost } from "../../../voice/VoiceHost";
import { agentPage, consoleRoute } from "../../../agent/page";
import type { NoteView } from "./view";

/**
 * The microphone over the note. Called from `NoteEditor`'s render, only while
 * the live editor is on screen and there is a voice host; see the call site.
 */
export function noteVoiceButton(view: NoteView, voice: VoiceHost) {
  const { editable, controls, compact, barUp, state, dictateAsked } = view;
  return (
    <VoiceButton
      page={{ ...voice.page, writable: voice.page.writable && editable }}
      controls={() => controls.current}
      compact={compact}
      /*
        Nothing draws a resting microphone in this corner any more, and the
        rule is one sentence on both densities: **while a `+` is on the
        glass, this stands down.**

        At a pointer density that `+` is the console's, which the *layout*
        mounts rather than this editor — so the editor is told, through the
        voice host, rather than deriving it from a width: the E2E fixture
        and the demo console are desktop-width surfaces with no `+` in that
        corner at all. See `VoiceHost.createButton`.

        On a phone it is the bottom row's own `+`, and `barUp` is what says
        that row is not on the glass: the accessory bar hides the frame's
        toolbar (see the `setAccessoryOpen` effect above), which is the same
        condition read from the side that causes it rather than from the
        height the frame publishes. So the microphone comes back with the
        caret — which is exactly when dictation has somewhere to type.

        **The phone half used to be argued from a microphone rather than
        from a `+`.** The row's seventh key was a microphone that opened the
        meeting flow, 24pt from this one and wearing the same glyph, and
        standing this one down was how "why are there 2 microphones?" was
        closed (`oneMicrophone.test.ts`). That key is gone — *"we no longer
        need a dedicated mic button on the bottom row, just a plus button
        that opens different options"* — and the condition is unchanged,
        because what it was really protecting is the corner: one floating
        control at a time, and the row's `+` is that control.

        What this never stands down is a microphone that is already open.
        The live capsule is the only way to stop a run and take back what
        it typed, and the failure card is a sentence owed to whoever opened
        one. `VoiceButton` draws both whatever this says.
      */
      microphoneElsewhere={compact ? !barUp : voice.createButton === true}
      /*
        Built here because this is the only place holding both halves: the
        console's voice host knows the context, and `state` is the editor
        itself — which is what knows whether the draft has diverged from
        the file. It carries references and never the note's text; see
        `features/agent/page.ts` for why that is a security property and
        not a size optimisation.
      */
      place={agentPage({
        context: voice.page.context,
        editor: state,
        route: consoleRoute(voice.page.context),
        /*
          False rather than read from the meetings store, because it is
          structurally false here: `VoiceButton` returns `null` for the
          whole of a meeting — there is one microphone and the meeting has
          it — so the conversation this feeds cannot be on screen while one
          runs. The field exists for the surfaces that will reach the agent
          from somewhere other than this control.
        */
        meetingLive: false,
        query: null,
      })}
      /*
        Absent on the three surfaces that provide no host value for it —
        the demo console, the E2E fixture, the visual fixture — where
        `VoiceButton` falls back to the stub. A conditional *value*, never
        a conditional hook: the engine is built in the console layout,
        which is mounted or not as a whole.
      */
      agent={voice.agent}
      /*
        The right-click menu's Dictate row, reaching the microphone this
        button owns. It is the same `start()` the sheet calls, so there is
        one dictation and one set of rules about when it may run — the menu
        is a second *door*, never a second implementation.
      */
      startDictation={dictateAsked}
      onRecordMeeting={voice.onRecordMeeting}
    />
  );
}
