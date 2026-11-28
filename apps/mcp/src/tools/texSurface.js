/**
 * CONTEXT'S TOOL SURFACE, AS TEX READS IT.
 *
 * Tex is becoming its own service, an MCP client of Context like any other
 * (docs/decisions/texting-assistant/tex-service.md). Besides calling a tool
 * (`tools/call`, `callToolForSession`), Tex reads what Context's tools are:
 * the list a session is offered (`tools/list`), the static catalog that list
 * and `orient`'s manual are built from (every definition with its schema and
 * annotations, the scope sets, the six's action tables), and a few pure
 * readings of a call against that catalog (which carrying tool a six call
 * reaches, an alias's canonical name, an argument check, a result in the six's
 * names). Plus the two reads of Context's own data a turn takes beside a tool:
 * a file's words, and the tools a standing forward may use.
 *
 * Tex reaches all of it through `packages/tex/gateway/contextMcp.js` and
 * through nothing else (one seam in place of the ten tool modules Tex imported), so this file is
 * the whole of what Context promises the Tex client here. The catalog is
 * static per deployment: when Tex runs as its own Worker it reads it once over
 * MCP (`tools/list` with every shape, and `orient`) and caches it; the
 * functions stay pure readings of that data. Nothing here decides authority:
 * `callToolForSession` refuses what a session may not do, whatever Tex was
 * shown.
 */

export { PRIVATE_TIER_ONLY_TOOLS, STAFF_ONLY_TOOLS, toolDefinitions, toolIsWriting } from "./registry.js";
export { UNLISTED_TOOLS, V2_ONLY_TOOLS, canonicalToolName, toolsForSession, validateArguments } from "./advertised.js";
export { ACTIONS } from "./v2/actions.js";
export { translateV2Params } from "./v2/translate.js";
export { resultInV2Names } from "./v2/speak.js";
export { actionArguments } from "../orient/manual.js";
export { disabledToolNames } from "../plugins/enablement.js";
export { MAX_FILE_BYTES, QUOTATION, fileWords, pdfPagesPart, readableFileType, typeOfFile, wordsWithoutPages } from "./readFile.js";
export { standingForwardTools } from "./forwardRule.js";
export { lastShownSend } from "./shownEmail.js";
