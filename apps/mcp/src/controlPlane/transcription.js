/**
 * Cloud transcription consent (`apps/convex/functions/transcriptionConsent.ts`,
 * docs/decisions/meetings/transcription-consent.md).
 */

export function createTranscriptionMethods({ post }) {
  return {
    /**
     * Whether audio arriving on this token may be sent to the transcription
     * service now: the token's own person has said yes to the current
     * disclosure, and the grant reaches `workspaceId`. Meetings only: a voice
     * message texted to Tex never asks. Fails closed: an unreachable control plane, an
     * odd answer and every refusal are all `false`, because the alternative
     * is sending somebody's recording on a guess.
     */
    async transcriptionConsent(accessToken, workspaceId) {
      try {
        const parsed = await post("/gateway/transcription/consent", {
          accessToken,
          expectedWorkspaceId: workspaceId,
        });
        return parsed?.allowed === true;
      } catch {
        return false;
      }
    },
  };
}
