/**
 * `/gateway/transcription/consent` for the stub, as
 * `apps/convex/functions/transcriptionConsent.ts` answers it: the token's own
 * person decides and the grant must reach the workspace. Every refusal is
 * `false`.
 *
 * `state.everyone` is true by default so suites about something else run as
 * an account that has said yes; a consent suite sets it false and names who
 * has said yes in `state.allowed`. Every ask is kept in `asks`.
 */

export function createTranscriptionRoutes(grantForAccessToken, coveredContexts) {
  const asks = [];
  const state = { everyone: true, allowed: new Set() };

  async function handle(path, body) {
    if (path !== "/gateway/transcription/consent") return undefined;
    asks.push({ accessToken: body.accessToken, workspaceId: body.expectedWorkspaceId });
    const grant = await grantForAccessToken(body.accessToken);
    if (!grant) return { allowed: false };
    if (!coveredContexts(grant).some((entry) => entry.workspaceId === body.expectedWorkspaceId)) return { allowed: false };
    return { allowed: state.everyone || state.allowed.has(grant.userId) };
  }

  return { handle, asks, state };
}
