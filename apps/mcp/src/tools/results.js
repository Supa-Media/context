/** The MCP tool-result shapes every tool handler returns. Moved verbatim out of `src/index.js`. */
import { toolText, toolError } from "../../../../packages/shared/src/texContract/toolContract.cjs";

export { toolText, toolError };

export function writePermissionError(operation = "destination") {
  return toolError(
    `permission denied: ${operation} is outside this connection's team-writable folder defaults. ` +
      "Call scope_info for the authorized write surface. " +
      "No private-path information is disclosed by this error."
  );
}
