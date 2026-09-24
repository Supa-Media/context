/**
 * Facade. Whether a plugin is actually running, and what stopped it if not.
 *
 * `runtimeFor` and its neighbours are the first thing in the product that can
 * answer that question, because they report what the sandbox host actually
 * did — a bundle loaded, a load that failed three times, or a version Context
 * has stopped. Nothing here derives "running" from a grant, from a verdict,
 * or from an install; a plugin with no row is not reported as anything.
 *
 * ## Facade
 *
 * The implementation is split by subject under `./runtime/`:
 *
 *  - `./runtime/state.ts` — `RuntimeState` and the pure functions over it:
 *    `shouldResumeRuntime`, `runtimeFor`, `runtimePill`, `runtimeNote`,
 *    `rollbackTarget`, `runtimeDetail`, `isRevocation`, `isOwnerStop`,
 *    `REVOKED_NOTE`.
 *  - `./runtime/commands.ts` — a plugin's registrations, status bar and
 *    commands: `PluginRegistration`, `describeRegistrations`,
 *    `registrationsFor`, `statusItemsFor`, `STATUS_BAR_NOTE`,
 *    `REGISTRATION_NOTE`, `SUGGEST_TIMEOUT_MS`, `PluginWorkReason`,
 *    `pluginWorkNote`, `CommandOutcome`, `commandOutcomeFor`,
 *    `PendingCommand`, `COMMAND_TIMEOUT_MS`, `commandPendingFor`,
 *    `EDITOR_COMMAND_HINT`, `editorCommandState`, `InvokeRequest`,
 *    `invokeFor`.
 *  - `./runtime/view.ts` — the shape handed to the plugins pane:
 *    `RuntimeView`, `OpenModal`, `OpenTextModal`, `PluginSettingRow`,
 *    `PluginSettingControl`, `OpenSettingsPane`, `ActiveSandbox`,
 *    `RuntimeActions`.
 *  - `./runtime/events.ts` — a plugin's own writes as vault events, and the
 *    suggestion/preview queries routed to one frame: `vaultEventForOperation`,
 *    `AppliedPluginNoteWrite`, `appliedPluginNoteWrite`, `SuggestRequest`,
 *    `suggestFor`, `freshSuggestions`, `currentWalk`, `PreviewRequest`,
 *    `previewFor`, `freshPreviews`, `PREVIEW_TIMEOUT_MS`, `maySeeContent`,
 *    `maySeePaths`.
 *
 * Re-exported here so no existing import of `./runtime` needs to change.
 */

export type { RuntimeState } from "./runtime/state";
export {
  shouldResumeRuntime,
  runtimeFor,
  runtimePill,
  runtimeNote,
  rollbackTarget,
  runtimeDetail,
  isRevocation,
  isOwnerStop,
  REVOKED_NOTE,
} from "./runtime/state";

export type {
  PluginRegistration,
  PluginWorkReason,
  CommandOutcome,
  PendingCommand,
  InvokeRequest,
} from "./runtime/commands";
export {
  SUGGEST_TIMEOUT_MS,
  pluginWorkNote,
  COMMAND_TIMEOUT_MS,
  commandPendingFor,
  describeRegistrations,
  registrationsFor,
  statusItemsFor,
  STATUS_BAR_NOTE,
  REGISTRATION_NOTE,
  commandOutcomeFor,
  EDITOR_COMMAND_HINT,
  editorCommandState,
  invokeFor,
} from "./runtime/commands";

export type {
  RuntimeView,
  OpenModal,
  OpenTextModal,
  PluginSettingRow,
  PluginSettingControl,
  OpenSettingsPane,
  ActiveSandbox,
  RuntimeActions,
} from "./runtime/view";

export type {
  AppliedPluginNoteWrite,
  SuggestRequest,
  PreviewRequest,
} from "./runtime/events";
export {
  vaultEventForOperation,
  appliedPluginNoteWrite,
  suggestFor,
  freshSuggestions,
  currentWalk,
  previewFor,
  freshPreviews,
  PREVIEW_TIMEOUT_MS,
  maySeeContent,
  maySeePaths,
} from "./runtime/events";
