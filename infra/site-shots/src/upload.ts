/**
 * Give a Browserbase browser one of the person's files the way the device's
 * own picker would: the file goes to the session's own storage through
 * Browserbase's Session Uploads API, and the browser itself sets it on the
 * page's file box with CDP `DOM.setFileInputFiles`, in whichever document
 * holds the box (the page, or a frame: ./cdp.ts, ./cdpFrames.ts).
 *
 * Added 2026-10-22. Before this, an upload wrote the file into the box from
 * page script (a DataTransfer, ./picker.ts). Some pickers (React and Angular
 * ones, Google Drive) ignore a file that the browser did not set itself.
 * The page-script way stays as the fallback (./browse.ts) for when this one
 * cannot set the file.
 *
 * Sabotage record (2026-10-22): a wrong uploads folder, a fixed mark, a
 * dropped site recheck, the page's site in place of the frame's, and a
 * skipped size check each fail tests.
 *
 * Nothing here keeps the file or logs its name or contents. The uploaded copy
 * lives on the session's own disk, which goes when the session is released.
 */

import type { BrowserbaseEnv } from "./browserbase";
import type { Uploads } from "./picker";

const API = "https://api.browserbase.com/v1";

/** Where Browserbase puts a session's uploaded files on the browser's own disk. */
export const UPLOAD_DIR = "/tmp/.uploads/";

type Send = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

/**
 * Send the file to the session's storage, and answer where the browser finds
 * it. The name was checked when the step was read (no slashes or controls),
 * so it cannot reach outside the uploads folder.
 */
export async function uploadToSession(
  env: BrowserbaseEnv,
  sessionId: string,
  file: { name: string; type: string; data: string },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const binary = atob(file.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const form = new FormData();
  form.append("file", new File([bytes], file.name, { type: file.type }));
  const response = await fetcher(`${API}/sessions/${encodeURIComponent(sessionId)}/uploads`, {
    method: "POST",
    headers: { "X-BB-API-Key": env.BROWSERBASE_API_KEY ?? "" },
    body: form,
  });
  // The vendor's error body is not relayed, as for every other call.
  if (!response.ok) throw new Error(`browserbase ${response.status}`);
  return `${UPLOAD_DIR}${file.name}`;
}

/**
 * Set `paths` (on the browser's disk) on the box `selector` finds, as the
 * browser, in the document `send` (and `contextId`, for a same-site frame's
 * world) reaches. False when there is no such element; the caller checks the
 * box took the file (./browse.ts).
 */
export async function setFileInput(send: Send, selector: string, paths: string[], contextId: number | null): Promise<boolean> {
  const found = await send<{ result?: { objectId?: string; subtype?: string } }>("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    ...(contextId === null ? {} : { contextId }),
  });
  const objectId = found?.result?.objectId;
  if (typeof objectId !== "string" || found.result?.subtype === "null") return false;
  await send("DOM.setFileInputFiles", { files: paths, objectId });
  return true;
}

/** The `Uploads` a browse on this Browserbase session gets (./browse.ts). */
export function browserbaseUploads(env: BrowserbaseEnv, sessionId: string, fetcher: typeof fetch = fetch): Uploads {
  return {
    stage: (file) => uploadToSession(env, sessionId, file, fetcher),
    // How the file went in, never what it was.
    said: (via) => console.log(JSON.stringify({ event: "site_shots_upload", via })),
  };
}
