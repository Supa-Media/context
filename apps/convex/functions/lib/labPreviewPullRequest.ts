/**
 * Whether a pull request still has a preview to open a Lab test chat on. A preview is deleted when its pull request
 * closes (`preview-cleanup.yml`), and the GitHub run that carries a test chat's calls then fails without a word to
 * the Lab, which went on saying the preview was starting (found 2026-11-24: a made-up chat opened on a merged pull
 * request). Asked before that run is started, so a closed one is refused with its reason.
 *
 * Only an answer GitHub gave refuses: if GitHub can't be asked, the run is started as before.
 */
import { LAB_REPO } from "../texLabRuns";

export type PullRequestState = { open: true } | { open: false; why: string } | null;

export async function previewPullRequest(pr: number, token: string | undefined, fetchImpl: typeof fetch = fetch): Promise<PullRequestState> {
  if (!token) return null;
  let res: Response;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${LAB_REPO}/pulls/${pr}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "context-tex-lab" },
    });
  } catch {
    return null;
  }
  if (res.status === 404) return { open: false, why: "there is no such pull request" };
  if (res.status !== 200) return null;
  const body = (await res.json().catch(() => null)) as { state?: unknown; merged_at?: unknown } | null;
  if (body?.state === "open") return { open: true };
  if (body?.state !== "closed") return null;
  // Said after "Pull request #N's preview could not be started:" (`labSandbox/preview.js`).
  return { open: false, why: `it is ${typeof body.merged_at === "string" ? "merged" : "closed"}, so its preview is gone. Pick an open pull request` };
}
