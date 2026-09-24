// @ts-check

import {
  SUGGEST_MAX,
  STATUS_BAR_MAX,
  PREVIEW_LINKS_MAX,
  PREVIEW_TEXT_MAX,
} from "./sandbox/message.js";
import { RUNTIME_CORE_JS } from "./sandbox/runtimeCore.js";
import { VAULT_API_JS } from "./sandbox/vaultApi.js";
import { COMPAT_JS } from "./sandbox/compat.js";
import { STATUS_BAR_JS } from "./sandbox/statusBar.js";
import { SUGGEST_JS } from "./sandbox/suggest.js";
import { PREVIEW_JS } from "./sandbox/preview.js";
import { PLUGIN_API_JS } from "./sandbox/pluginApi.js";
import { MODAL_JS } from "./sandbox/modal.js";
import { VIEWS_JS } from "./sandbox/views.js";
import { SETTINGS_JS } from "./sandbox/settingsPane.js";
import { NETWORK_JS } from "./sandbox/network.js";
import { EDITOR_JS } from "./sandbox/editor.js";
import { LIFECYCLE_JS } from "./sandbox/lifecycle.js";

/**
 * The document that executes one reviewed plugin bundle.
 *
 * The bundle never enters this string. The trusted host sends it only after the
 * frame has loaded, which means plugin text cannot break out of an HTML or
 * script delimiter while the sandbox is being constructed. The frame has an
 * opaque origin (`sandbox="allow-scripts"`, without `allow-same-origin`) and a
 * CSP that denies every ambient network and child-execution surface. All note
 * access therefore has to cross the small postMessage protocol below.
 *
 * The body of the sandboxed script is assembled from the modules under
 * `./sandbox/`, split by responsibility (RPC core, vault shim, DOM compat,
 * status bar, suggestions, preview, plugin API, dialogs, views, settings
 * pane, network, editor, lifecycle). Each exports the exact source text that
 * used to live inline here; concatenating them reproduces this function's
 * previous output byte for byte.
 */
export function pluginSandboxDocument() {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; media-src 'none'; font-src 'none'; child-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">
</head><body><script>
(() => {
` + RUNTIME_CORE_JS + VAULT_API_JS + COMPAT_JS + STATUS_BAR_JS + SUGGEST_JS + PREVIEW_JS
    + PLUGIN_API_JS + MODAL_JS + VIEWS_JS + SETTINGS_JS + NETWORK_JS + EDITOR_JS + LIFECYCLE_JS
    + `})();
</script></body></html>`;
}


export {
  sandboxFrameIsOurs,
  SUGGEST_MAX,
  STATUS_BAR_MAX,
  SUGGEST_MODAL_INSTRUCTIONS_MAX,
  SETTING_TEXT_CAP,
  SETTING_DESC_CAP,
  SETTING_VALUE_CAP,
  SETTING_OPTIONS_CAP,
  SETTING_ROWS_CAP,
  TEXT_MODAL_TITLE_CAP,
  TEXT_MODAL_TEXT_CAP,
  PREVIEW_LINKS_MAX,
  PREVIEW_TEXT_MAX,
  PLUGIN_WORK_REASONS,
  parsePluginSandboxMessage,
} from "./sandbox/message.js";
