// Tex's copy of apps/mcp/src/controlPlane/client.js and apps/mcp/src/ingestion/inbox.js `sha256Hex` (the gateway keeps its own).
export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
