# The desktop shell

_See `docs/decisions/README.md` for the index._

The owner's decision, 2026-09-07: *"Make sure the Mac app can receive a form of
OTA updates as well. Making changes to the app should be one runtime for web,
mobile and desktop."*

That is one sentence with two halves, and they are the same half. The Mac app
gets over-the-air updates **because** it stops having a UI of its own: the Expo
app in `apps/mobile` is already the single UI on web, iOS and Android, and it
becomes the UI on macOS too. Electron becomes a **shell** — a native process
that owns a tray, a microphone, a system-audio tap, a credential and an outbox,
and hosts that UI behind a typed bridge. A change to a screen ships once, the
moment `deploy-web.yml` publishes, and reaches a browser, a phone and a Mac
without anybody building a binary.

What the shell keeps is what a web page cannot have: the menu bar, the loopback
audio tap, `safeStorage`, a queue that drains with no window open, and the
machine's own revocable OAuth grant. Those are the reason a desktop app exists
at all ([meetings](./meetings.md), *Nothing joins the call*), and none of them
is a screen.

This file was written while `#264` (desktop capture) and `#265` (desktop
packaging) were open and unmerged, and both have since merged to `main`. Every
file it names is named as it exists on those branches, and stayed accurate
across the merge; where a decision argues against something one of them just
built, it says so rather than pretending the code is already gone.

---

### The shell loads the hosted console, and keeps a mirror of the last good load

Moved to [The shell loads the hosted console, and keeps a mirror of the last good load](./desktop/shell-and-bridge.md#the-shell-loads-the-hosted-console-and-keeps-a-mirror-of-the-last-good-load).

### Sign-in stays in the page, the grant stays in the main process, and they are not the same credential

Moved to [Sign-in stays in the page, the grant stays in the main process, and they are not the same credential](./desktop/shell-and-bridge.md#sign-in-stays-in-the-page-the-grant-stays-in-the-main-process-and-they-are-not-the-same-credential).

### The bridge is a package, it is versioned, and the gateway may never import it

Moved to [The bridge is a package, it is versioned, and the gateway may never import it](./desktop/shell-and-bridge.md#the-bridge-is-a-package-it-is-versioned-and-the-gateway-may-never-import-it).

### The main process survives whole; the renderer is what is deleted

Moved to [The main process survives whole; the renderer is what is deleted](./desktop/shell-and-bridge.md#the-main-process-survives-whole-the-renderer-is-what-is-deleted).

### The shell updates itself with `electron-updater`, and never during a meeting

Moved to [The shell updates itself with `electron-updater`, and never during a meeting](./desktop/shell-and-bridge.md#the-shell-updates-itself-with-electron-updater-and-never-during-a-meeting).

### Step 7 landed: a release, not a draft, and the meeting always wins

Moved to [Step 7 landed: a release, not a draft, and the meeting always wins](./desktop/shell-and-bridge.md#step-7-landed-a-release-not-a-draft-and-the-meeting-always-wins).

### Nothing had ever started this app

Moved to [Nothing had ever started this app](./desktop/launch-and-origins.md#nothing-had-ever-started-this-app).

### Nothing that can start a recording may come from an origin we did not pin

Moved to [Nothing that can start a recording may come from an origin we did not pin](./desktop/launch-and-origins.md#nothing-that-can-start-a-recording-may-come-from-an-origin-we-did-not-pin).

### The approval happens in the app's own window, and that buys exactly one new address

Moved to [The approval happens in the app's own window, and that buys exactly one new address](./desktop/approval-and-addresses.md#the-approval-happens-in-the-apps-own-window-and-that-buys-exactly-one-new-address).

### And then the approval stopped happening at all, which is the point

Moved to [And then the approval stopped happening at all, which is the point](./desktop/approval-and-addresses.md#and-then-the-approval-stopped-happening-at-all-which-is-the-point).

### Offline is what the outbox was always for, plus a tray that needs no page

Moved to [Offline is what the outbox was always for, plus a tray that needs no page](./desktop/offline-and-releases.md#offline-is-what-the-outbox-was-always-for-plus-a-tray-that-needs-no-page).

### Step 6 landed: one origin at a time, and a mirror that refuses data

Moved to [Step 6 landed: one origin at a time, and a mirror that refuses data](./desktop/offline-and-releases.md#step-6-landed-one-origin-at-a-time-and-a-mirror-that-refuses-data).

### The order is seven pull requests, and the first one changes nothing by default

Moved to [The order is seven pull requests, and the first one changes nothing by default](./desktop/offline-and-releases.md#the-order-is-seven-pull-requests-and-the-first-one-changes-nothing-by-default).

### Step 4 landed: the console is what a launch opens, and the panel is one variable away

Moved to [Step 4 landed: the console is what a launch opens, and the panel is one variable away](./desktop/offline-and-releases.md#step-4-landed-the-console-is-what-a-launch-opens-and-the-panel-is-one-variable-away).

### The signing keychain belongs to the workflow, not to electron-builder

Moved to [The signing keychain belongs to the workflow, not to electron-builder](./desktop/signing-and-credentials.md#the-signing-keychain-belongs-to-the-workflow-not-to-electron-builder).

### What step 3 did not do, and what has since been done about it

Moved to [What step 3 did not do, and what has since been done about it](./desktop/signing-and-credentials.md#what-step-3-did-not-do-and-what-has-since-been-done-about-it).

### One meeting is one credential, and on a Mac it is the machine's

Moved to [One meeting is one credential, and on a Mac it is the machine's](./desktop/signing-and-credentials.md#one-meeting-is-one-credential-and-on-a-mac-it-is-the-machines).

### A release is a build that started

Moved to [A release is a build that started](./desktop/release-and-launch-health.md#a-release-is-a-build-that-started).

### A slow Rosetta launch is not a crash, so it does not get the same deadline

Moved to [A slow Rosetta launch is not a crash, so it does not get the same deadline](./desktop/release-and-launch-health.md#a-slow-rosetta-launch-is-not-a-crash-so-it-does-not-get-the-same-deadline).

### The mirror was refusing the console itself, and `--smoke` never noticed

Moved to [The mirror was refusing the console itself, and `--smoke` never noticed](./desktop/release-and-launch-health.md#the-mirror-was-refusing-the-console-itself-and---smoke-never-noticed).

### Offline with a mirror is success, and the exit code says so

Moved to [Offline with a mirror is success, and the exit code says so](./desktop/release-and-launch-health.md#offline-with-a-mirror-is-success-and-the-exit-code-says-so).

### The microphone is asked for just-in-time, and never a dialog that points at the wrong place

Moved to [The microphone is asked for just-in-time, and never a dialog that points at the wrong place](./desktop/microphone-and-recording.md#the-microphone-is-asked-for-just-in-time-and-never-a-dialog-that-points-at-the-wrong-place).

### Twenty is less than thirty, and every recording died of it

Moved to [Twenty is less than thirty, and every recording died of it](./desktop/microphone-and-recording.md#twenty-is-less-than-thirty-and-every-recording-died-of-it).

### The level meter had a subscriber, a normaliser, a fake and no producer

Moved to [The level meter had a subscriber, a normaliser, a fake and no producer](./desktop/level-meter-and-band.md#the-level-meter-had-a-subscriber-a-normaliser-a-fake-and-no-producer).

### What is deliberately not built

Moved to [What is deliberately not built](./desktop/level-meter-and-band.md#what-is-deliberately-not-built).

### The console reserves the space, the shell places the buttons

Moved to [The console reserves the space, the shell places the buttons](./desktop/level-meter-and-band.md#the-console-reserves-the-space-the-shell-places-the-buttons).

### The band's other two payers, and the shell half finally wired

Moved to [The band's other two payers, and the shell half finally wired](./desktop/level-meter-and-band.md#the-bands-other-two-payers-and-the-shell-half-finally-wired).

### The band moves into the bar

Moved to [The band moves into the bar](./desktop/level-meter-and-band.md#the-band-moves-into-the-bar).

### Bridge version 4 adds `imessage`, and it is a status object, never a query surface

Moved to [Bridge version 4 adds `imessage`, and it is a status object, never a query surface](./desktop/bridge-and-audio.md#bridge-version-4-adds-imessage-and-it-is-a-status-object-never-a-query-surface).

### System audio had never worked once, and the comment above it is why

Moved to [System audio had never worked once, and the comment above it is why](./desktop/bridge-and-audio.md#system-audio-had-never-worked-once-and-the-comment-above-it-is-why).
