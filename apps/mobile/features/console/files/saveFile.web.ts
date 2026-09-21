/**
 * Hand the browser a file to keep — web.
 *
 * An object URL and a synthetic click, which is the whole of "download" on the
 * web platform and has been since `download` landed on `<a>`. Three details
 * are not decoration:
 *
 *  - **The URL is revoked.** An object URL pins its blob in memory for the
 *    life of the document, and a console somebody leaves open all day is
 *    exactly where a leak of whole-folder archives would accumulate. Revoked on
 *    a later turn rather than immediately, because a revoke in the same tick
 *    as the click races the browser's own fetch of it in Safari.
 *  - **The anchor is removed.** Appending to `document.body` is required —
 *    Firefox ignores a click on a detached anchor — and leaving it there would
 *    put an invisible link at the end of every page for every download.
 *  - **It answers whether it could.** A surface with no DOM is not a failure
 *    to report as one, and the caller says so in its own words rather than
 *    throwing an error nobody wrote for a person.
 */
export function saveFile(
  name: string,
  bytes: Uint8Array,
  contentType: string,
): boolean {
  if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") {
    return false;
  }
  /*
    A copy into a plain `ArrayBuffer`, because `bytes` may be a view onto a
    larger buffer and `new Blob([view])` is only correct for the whole of it on
    some engines. One allocation on a path that has already built the archive.
  */
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: contentType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}
