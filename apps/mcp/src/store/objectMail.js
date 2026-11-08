/**
 * A note's mail, asked of the workspace object that holds the note (`workspaceStore/mailOps.js`), for a session that
 * reads that object (`objectReader`). `null` where it does not; each call answers `null` where the object did not
 * serve it (not its home, failing, or behind a narrowing change), and the caller reads the note as before. Nothing
 * here asks the control plane.
 */
import { objectReader } from "./objectLookup.js";

/**
 * @param {Parameters<typeof objectReader>[0]} options
 * @returns {{since: (path: string, name: string, readThrough: string|null) => Promise<object|null>, wait: (path: string, ask: {from: string, to: string, since: string, seconds: number}) => Promise<object|null>} | null}
 */
export function objectFirstMail(options) {
  const reader = objectReader(options);
  if (reader === null || typeof reader.client?.mail?.since !== "function") return null;
  const { client, judged, settledBehind, log, workspaceId } = reader;
  const served = (answer) => (answer?.served === true && !settledBehind(answer) ? answer : null);
  return {
    async since(path, name, readThrough) {
      try {
        return served(await client.mail.since({ path, name, readThrough: readThrough ?? null, ...judged }));
      } catch (error) {
        log("workspace_object_mail_failed", { workspaceId, op: "since", error: error?.name ?? "Error" });
        return null;
      }
    },
    async wait(path, { from, to, since, seconds }) {
      try {
        return served(await client.mail.wait({ path, from, to, since, timeoutMs: Math.round(seconds * 1000), ...judged }));
      } catch (error) {
        log("workspace_object_mail_failed", { workspaceId, op: "wait", error: error?.name ?? "Error" });
        return null;
      }
    },
  };
}
