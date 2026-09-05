/**
 * The notepad: the human's own Markdown on the left, the transcript beside it.
 *
 * Three rules, and each of them is a line of code you could delete without any
 * test noticing, which is why they are written down:
 *
 * **The rail never steals the caret.** New segments are appended and the rail
 * scrolls itself; nothing calls `focus()` except the editor, once, when the
 * window is first given a session. A transcript that grabbed focus mid-sentence
 * would make this window unusable during the meeting it is for.
 *
 * **The rail only follows if it was already at the bottom.** Somebody scrolling
 * back to read what was said five minutes ago must not be yanked forward every
 * five seconds.
 *
 * **The editor is not re-rendered from state while it has focus.** State
 * arrives on every tick; assigning `value` would move the caret to the end on
 * every keystroke round trip.
 */

import { formatElapsed } from "../core/tray/presentation.ts";
import type { UiState } from "../main/ipc.ts";


const elapsed = document.getElementById("elapsed") as HTMLElement;
const where = document.getElementById("where") as HTMLElement;
const pause = document.getElementById("pause") as HTMLButtonElement;
const end = document.getElementById("end") as HTMLButtonElement;
const title = document.getElementById("title") as HTMLInputElement;
const notes = document.getElementById("notes") as HTMLTextAreaElement;
const transcript = document.getElementById("transcript") as HTMLElement;
const engine = document.getElementById("engine") as HTMLElement;
const railFoot = document.getElementById("rail-foot") as HTMLElement;
const rail = document.querySelector(".rail") as HTMLElement;

/**
 * Which segments are already on screen, and for which meeting.
 *
 * The session id is half of this pair on purpose. Segments are appended
 * incrementally — re-rendering the rail on every state push would fight the
 * scroll position and the selection — so without the id, ending one meeting
 * and starting another would stack the second transcript under the first, and
 * the ids would not collide to give it away.
 */
let rendered = new Set<string>();
let renderedSession: string | null = null;
let focusedOnce = false;

function renderTranscript(state: UiState): void {
  const session = state.session;
  if (!session) return;

  // "Already at the bottom" is measured before anything is appended.
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;

  if (session.id !== renderedSession) {
    renderedSession = session.id;
    rendered = new Set();
    focusedOnce = false;
    transcript.replaceChildren();
  }

  if (session.transcript.length === 0 && rendered.size === 0) {
    transcript.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = session.capturing
      ? "Listening. Lines appear here as people speak."
      : "Nothing yet.";
    transcript.append(empty);
    return;
  }

  for (const segment of session.transcript) {
    if (rendered.has(segment.id)) continue;
    if (rendered.size === 0) transcript.replaceChildren();
    rendered.add(segment.id);

    const block = document.createElement("div");
    block.className = "segment";
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = `${formatElapsed(segment.startMs)} · ${segment.speaker ?? (segment.channel === "mic" ? "You" : "Them")}`;
    const said = document.createElement("span");
    said.className = "said";
    // textContent, never innerHTML: this is what somebody said, verbatim.
    said.textContent = segment.text;
    block.append(when, said);
    transcript.append(block);
  }

  if (atBottom) transcript.scrollTop = transcript.scrollHeight;
}

function render(state: UiState): void {
  const session = state.session;
  document.body.dataset["state"] = session?.state ?? "idle";

  elapsed.textContent = formatElapsed(session?.elapsedMs ?? 0);
  where.textContent = session ? `${session.title} · ${session.transcriptionLabel}` : "No meeting";
  pause.textContent = session?.state === "paused" ? "Resume" : "Pause";
  pause.disabled = !session;
  end.disabled = !session;

  if (session) {
    if (document.activeElement !== title) title.value = session.title;
    if (document.activeElement !== notes) notes.value = session.notes;
    if (!focusedOnce) {
      notes.focus();
      focusedOnce = true;
    }
    engine.textContent = session.transcriptionLabel;
    rail.dataset["leaves"] = String(session.audioLeavesDevice);
    railFoot.textContent = session.audioLeavesDevice
      ? "Audio is streamed for transcription and never stored. Only text is written to your bucket."
      : "Audio never leaves this machine. Only text is written to your bucket.";
    renderTranscript(state);
  }
}

pause.addEventListener("click", () => {
  if (document.body.dataset["state"] === "paused") window.context.resume();
  else window.context.pause();
});
end.addEventListener("click", () => window.context.end());
notes.addEventListener("input", () => window.context.notes(notes.value));
title.addEventListener("input", () => window.context.title(title.value));

window.context.onState(render);
