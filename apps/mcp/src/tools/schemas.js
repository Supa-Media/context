/**
 * Every tool's advertised name, description and input schema.
 *
 * Moved verbatim out of `src/index.js`, then split by tool family under
 * `schemas/`. `baseToolDefinitions` concatenates the families in the order
 * the single literal had, so the list — and `tools/list`, which is built from
 * it — is unchanged, element for element. Each family is a function, as the
 * whole list was, so every call still builds fresh objects.
 */

import { coreToolDefinitions } from "./schemas/core.js";
import { communicationsToolDefinitions } from "./schemas/communications.js";
import { noteWriteToolDefinitions } from "./schemas/notes.js";
import { proposalToolDefinitions } from "./schemas/proposals.js";
import { searchAndMoveToolDefinitions } from "./schemas/moves.js";
import { saveAndLinkToolDefinitions } from "./schemas/links.js";
import { formToolDefinitions } from "./schemas/forms.js";
import { activityToolDefinitions } from "./schemas/activity.js";

export function baseToolDefinitions() {
  return [
    ...coreToolDefinitions(),
    ...communicationsToolDefinitions(),
    ...noteWriteToolDefinitions(),
    ...proposalToolDefinitions(),
    ...searchAndMoveToolDefinitions(),
    ...saveAndLinkToolDefinitions(),
    ...formToolDefinitions(),
    ...activityToolDefinitions(),
  ];
}
