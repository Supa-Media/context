# Meetings

_See `docs/decisions/README.md` for the index._

Context records meetings. Not as a separate product with its own account, its own
storage and its own export button, but as a capture surface for the thing this
repository already is: **a meeting becomes plain Markdown in a bucket the
customer owns, and every AI client they have already connected can read it
through the same endpoint, with nothing to integrate.** That sentence is the
entire reason this lives here and not in a new repository. A meeting recorder
that held your meetings would be a competitor to us as much as to anyone else.

The contract every surface agrees to is `packages/meetings/src/protocol.js`.
It is the single source of truth for what a meeting *is*: the session shape, the
state machine, the events, the gateway routes, the detection inputs and the
watch's five verbs. The decisions below are the arguments behind it. Changing
one of them means changing that file, which means changing every client at once
— which is the point of having it.

### One file per meeting, and `read_meeting` is what that costs

Moved to [One file per meeting, and `read_meeting` is what that costs](./meetings/capture-and-recording.md#one-file-per-meeting-and-read_meeting-is-what-that-costs).

### A meeting note is a note, and `privacy.md` decides it with no bypass

Moved to [A meeting note is a note, and `privacy.md` decides it with no bypass](./meetings/capture-and-recording.md#a-meeting-note-is-a-note-and-privacymd-decides-it-with-no-bypass).

### Nothing joins the call

Moved to [Nothing joins the call](./meetings/capture-and-recording.md#nothing-joins-the-call).

### A browser records the whole call only if somebody hands it the call

Moved to [A browser records the whole call only if somebody hands it the call](./meetings/capture-and-recording.md#a-browser-records-the-whole-call-only-if-somebody-hands-it-the-call).

### iOS recording survives screen lock through two deliberate controls

Moved to [iOS recording survives screen lock through two deliberate controls](./meetings/capture-and-recording.md#ios-recording-survives-screen-lock-through-two-deliberate-controls).

### Transcription is cloud on the paid tier and on-device on the free tier, and that seam is disclosed, not glossed

Moved to [Transcription is cloud on the paid tier and on-device on the free tier, and that seam is disclosed, not glossed](./meetings/capture-and-recording.md#transcription-is-cloud-on-the-paid-tier-and-on-device-on-the-free-tier-and-that-seam-is-disclosed-not-glossed).

### The channel is the only speaker signal this product has, and a turn never crosses it

Moved to [The channel is the only speaker signal this product has, and a turn never crosses it](./meetings/capture-and-recording.md#the-channel-is-the-only-speaker-signal-this-product-has-and-a-turn-never-crosses-it).

### The cloud path knows *who* is asking, opaquely, and the ceiling is the control plane's

Moved to [The cloud path knows *who* is asking, opaquely, and the ceiling is the control plane's](./meetings/transcription-and-tiers.md#the-cloud-path-knows-who-is-asking-opaquely-and-the-ceiling-is-the-control-planes).

### The desktop is an OAuth client of the gateway, and it asks for the tier its meetings are filed at

Moved to [The desktop is an OAuth client of the gateway, and it asks for the tier its meetings are filed at](./meetings/transcription-and-tiers.md#the-desktop-is-an-oauth-client-of-the-gateway-and-it-asks-for-the-tier-its-meetings-are-filed-at).

### A recorder that holds a grant transcribes at the gateway, and the meeting's own record is the ceiling

Moved to [A recorder that holds a grant transcribes at the gateway, and the meeting's own record is the ceiling](./meetings/transcription-and-tiers.md#a-recorder-that-holds-a-grant-transcribes-at-the-gateway-and-the-meetings-own-record-is-the-ceiling).

### Pressing Record is the same yes, and the blocklist sees less of it

Moved to [Pressing Record is the same yes, and the blocklist sees less of it](./meetings/capture-plumbing.md#pressing-record-is-the-same-yes-and-the-blocklist-sees-less-of-it).

### A microphone is never opened for a meeting nothing will transcribe

Moved to [A microphone is never opened for a meeting nothing will transcribe](./meetings/capture-plumbing.md#a-microphone-is-never-opened-for-a-meeting-nothing-will-transcribe).

### A chunk of audio is a whole file, and every recorder cuts on the same clock

Moved to [A chunk of audio is a whole file, and every recorder cuts on the same clock](./meetings/capture-plumbing.md#a-chunk-of-audio-is-a-whole-file-and-every-recorder-cuts-on-the-same-clock).

### A client-supplied id is bounded where it enters — and, since 2026-09-05, where it lands as well

Moved to [A client-supplied id is bounded where it enters — and, since 2026-09-05, where it lands as well](./meetings/capture-plumbing.md#a-client-supplied-id-is-bounded-where-it-enters-and-since-2026-09-05-where-it-lands-as-well).

### The device is never waiting on the network, and a backlog is dropped rather than kept

Moved to [The device is never waiting on the network, and a backlog is dropped rather than kept](./meetings/capture-plumbing.md#the-device-is-never-waiting-on-the-network-and-a-backlog-is-dropped-rather-than-kept).

### Audio nobody has transcribed yet is kept on the device

Moved to [Audio nobody has transcribed yet is kept on the device](./meetings/capture-plumbing.md#audio-nobody-has-transcribed-yet-is-kept-on-the-device).

### The recorder is one interface with two implementations, and nothing above it knows which

Moved to [The recorder is one interface with two implementations, and nothing above it knows which](./meetings/capture-plumbing.md#the-recorder-is-one-interface-with-two-implementations-and-nothing-above-it-knows-which).

### The watch is a remote control, never a recorder

Moved to [The watch is a remote control, never a recorder](./meetings/watch-and-state.md#the-watch-is-a-remote-control-never-a-recorder).

### Detection judgement is a pure function, and the desktop app only collects evidence

Moved to [Detection judgement is a pure function, and the desktop app only collects evidence](./meetings/watch-and-state.md#detection-judgement-is-a-pure-function-and-the-desktop-app-only-collects-evidence).

### The state table is the client's, and a move it refuses is a client faking one

Moved to [The state table is the client's, and a move it refuses is a client faking one](./meetings/watch-and-state.md#the-state-table-is-the-clients-and-a-move-it-refuses-is-a-client-faking-one).

### `written` is the gateway's word, and a client may never say it

Moved to [`written` is the gateway's word, and a client may never say it](./meetings/watch-and-state.md#written-is-the-gateways-word-and-a-client-may-never-say-it).

### A meeting route is a reserved name, not somebody's handle

Moved to [A meeting route is a reserved name, not somebody's handle](./meetings/watch-and-state.md#a-meeting-route-is-a-reserved-name-not-somebodys-handle).

### An ack says whether the write was conflict-safe, because some buckets are not

Moved to [An ack says whether the write was conflict-safe, because some buckets are not](./meetings/watch-and-state.md#an-ack-says-whether-the-write-was-conflict-safe-because-some-buckets-are-not).

### Ingestion is idempotent by construction, because losing signal is the normal case

Moved to [Ingestion is idempotent by construction, because losing signal is the normal case](./meetings/watch-and-state.md#ingestion-is-idempotent-by-construction-because-losing-signal-is-the-normal-case).

### The human's words are never rewritten, and the generated half is disposable

Moved to [The human's words are never rewritten, and the generated half is disposable](./meetings/watch-and-state.md#the-humans-words-are-never-rewritten-and-the-generated-half-is-disposable).

### A meeting lands at an ordinary path, and nothing about it is namespaced

Moved to [A meeting lands at an ordinary path, and nothing about it is namespaced](./meetings/namespacing-and-signing.md#a-meeting-lands-at-an-ordinary-path-and-nothing-about-it-is-namespaced).

### The Mac app is signed by a workflow nobody's branch can start, and builds honestly unsigned until then

Moved to [The Mac app is signed by a workflow nobody's branch can start, and builds honestly unsigned until then](./meetings/namespacing-and-signing.md#the-mac-app-is-signed-by-a-workflow-nobodys-branch-can-start-and-builds-honestly-unsigned-until-then).

### What is deliberately not built

Moved to [What is deliberately not built](./meetings/namespacing-and-signing.md#what-is-deliberately-not-built).

### Consent is the customer's, and the product may never make recording invisible

Moved to [Consent is the customer's, and the product may never make recording invisible](./meetings/namespacing-and-signing.md#consent-is-the-customers-and-the-product-may-never-make-recording-invisible).

### The way in is on the surface each density has, and it navigates rather than records

Moved to [The way in is on the surface each density has, and it navigates rather than records](./meetings/ui-surfaces.md#the-way-in-is-on-the-surface-each-density-has-and-it-navigates-rather-than-records).

### The press records, and the indicator is the disclosure (2026-09-19)

Moved to [The press records, and the indicator is the disclosure (2026-09-19)](./meetings/ui-surfaces.md#the-press-records-and-the-indicator-is-the-disclosure-2026-09-19).

### A meeting opens in the panel, and the corner is a `+` (2026-09-19)

Moved to [A meeting opens in the panel, and the corner is a `+` (2026-09-19)](./meetings/ui-surfaces.md#a-meeting-opens-in-the-panel-and-the-corner-is-a-2026-09-19).

### The phone has a meter, and it always did

Moved to [The phone has a meter, and it always did](./meetings/ui-surfaces.md#the-phone-has-a-meter-and-it-always-did).

### ...and so does a browser, which is the third surface that drew a claim it could not keep

Moved to [...and so does a browser, which is the third surface that drew a claim it could not keep](./meetings/ui-surfaces.md#and-so-does-a-browser-which-is-the-third-surface-that-drew-a-claim-it-could-not-keep).

### Ending a meeting is not waiting for it to be transcribed

Moved to [Ending a meeting is not waiting for it to be transcribed](./meetings/ui-surfaces.md#ending-a-meeting-is-not-waiting-for-it-to-be-transcribed).

### One recording per meeting, because iOS will not let a locked phone start a second one

Moved to [One recording per meeting, because iOS will not let a locked phone start a second one](./meetings/ui-surfaces.md#one-recording-per-meeting-because-ios-will-not-let-a-locked-phone-start-a-second-one).

### A meeting is written the way a note is, because that is what it is

Moved to [A meeting is written the way a note is, because that is what it is](./meetings/notes-and-filing.md#a-meeting-is-written-the-way-a-note-is-because-that-is-what-it-is).

### The notepad holds the keyboard open, so the transport rides it

Moved to [The notepad holds the keyboard open, so the transport rides it](./meetings/notes-and-filing.md#the-notepad-holds-the-keyboard-open-so-the-transport-rides-it).

### A meeting with no readable date is shown without one, not dropped

Moved to [A meeting with no readable date is shown without one, not dropped](./meetings/notes-and-filing.md#a-meeting-with-no-readable-date-is-shown-without-one-not-dropped).

### A meeting nobody addressed goes to the recorder's own workspace

Moved to [A meeting nobody addressed goes to the recorder's own workspace](./meetings/notes-and-filing.md#a-meeting-nobody-addressed-goes-to-the-recorders-own-workspace).

### A refusal is a sentence this app wrote, and it maps the codes the server sends

Moved to [A refusal is a sentence this app wrote, and it maps the codes the server sends](./meetings/notes-and-filing.md#a-refusal-is-a-sentence-this-app-wrote-and-it-maps-the-codes-the-server-sends).

### The note says the meeting is over, and Copy is the file in the bucket

Moved to [The note says the meeting is over, and Copy is the file in the bucket](./meetings/notes-and-filing.md#the-note-says-the-meeting-is-over-and-copy-is-the-file-in-the-bucket).

### A day's meetings are in order even when an undated one is on the list

Moved to [A day's meetings are in order even when an undated one is on the list](./meetings/notes-and-filing.md#a-days-meetings-are-in-order-even-when-an-undated-one-is-on-the-list).

### Android is prepared, not shipped

Moved to [Android is prepared, not shipped](./meetings/android-and-sessions.md#android-is-prepared-not-shipped).

### A `finalizing` session has a deadline, because the gateway does not need one

Moved to [A `finalizing` session has a deadline, because the gateway does not need one](./meetings/android-and-sessions.md#a-finalizing-session-has-a-deadline-because-the-gateway-does-not-need-one).

### Silence is not a transcript, and the engine's own evidence is what says so

Moved to [Silence is not a transcript, and the engine's own evidence is what says so](./meetings/transcription-evidence.md#silence-is-not-a-transcript-and-the-engines-own-evidence-is-what-says-so).

### A session that captured nothing is not filed

Moved to [A session that captured nothing is not filed](./meetings/capture-integrity.md#a-session-that-captured-nothing-is-not-filed).

### A recording that has outlived its own capture is failed, not counted

Moved to [A recording that has outlived its own capture is failed, not counted](./meetings/capture-integrity.md#a-recording-that-has-outlived-its-own-capture-is-failed-not-counted).

## A segment id names its own meeting, and both sides check it

Moved to [A segment id names its own meeting, and both sides check it](./meetings/segment-and-refusal.md#a-segment-id-names-its-own-meeting-and-both-sides-check-it).

## The phone had one barrier where the desktop has four, and both halves are named

Moved to [The phone had one barrier where the desktop has four, and both halves are named](./meetings/segment-and-refusal.md#the-phone-had-one-barrier-where-the-desktop-has-four-and-both-halves-are-named).

## The count is a kind, not a number, and every one of these guards reads an id

Moved to [The count is a kind, not a number, and every one of these guards reads an id](./meetings/segment-and-refusal.md#the-count-is-a-kind-not-a-number-and-every-one-of-these-guards-reads-an-id).

## A refusal is shown with the reason the gateway gave for it

Moved to [A refusal is shown with the reason the gateway gave for it](./meetings/segment-and-refusal.md#a-refusal-is-shown-with-the-reason-the-gateway-gave-for-it).

## The seventh key became a row in the `+`, and the route it guarded did not move

Moved to [The seventh key became a row in the `+`, and the route it guarded did not move](./meetings/evidence-and-builds.md#the-seventh-key-became-a-row-in-the-and-the-route-it-guarded-did-not-move).

## A permanent, correct refusal is not the same fact as a transient one, and must not share its sentence

Moved to [A permanent, correct refusal is not the same fact as a transient one, and must not share its sentence](./meetings/evidence-and-builds.md#a-permanent-correct-refusal-is-not-the-same-fact-as-a-transient-one-and-must-not-share-its-sentence).

## The engine's own evidence travels to the recorder, because a Worker's log is not a place a person can read

Moved to [The engine's own evidence travels to the recorder, because a Worker's log is not a place a person can read](./meetings/evidence-and-builds.md#the-engines-own-evidence-travels-to-the-recorder-because-a-workers-log-is-not-a-place-a-person-can-read).

## A build is what shipped, not what merged — two "the fix did not work" reports were one build

Moved to [A build is what shipped, not what merged — two "the fix did not work" reports were one build](./meetings/evidence-and-builds.md#a-build-is-what-shipped-not-what-merged-two-the-fix-did-not-work-reports-were-one-build).

## A resumed meeting is a new part spliced into the note it already has (2026-09-23)

Moved to [A resumed meeting is a new part spliced into the note it already has (2026-09-23)](./meetings/evidence-and-builds.md#a-resumed-meeting-is-a-new-part-spliced-into-the-note-it-already-has-2026-09-23).
