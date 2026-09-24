/** The MCP tool-result shapes every tool handler returns. Moved verbatim out of `src/index.js`. */

export function toolText(text) {
  return { content: [{ type: "text", text }] };
}
export function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

export function writePermissionError(operation = "destination") {
  return toolError(
    `permission denied: ${operation} is outside this connection's team-writable folder defaults. ` +
      "Call scope_info for the authorized write surface or use propose_note for the correct destination. " +
      "No private-path information is disclosed by this error."
  );
}
