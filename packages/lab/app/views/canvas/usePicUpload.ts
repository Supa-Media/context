/**
 * The test chat's picture upload: the file into Convex storage (the Testing tab's `texSets.picUploadUrl` / `picUrl`),
 * answering where it is served. Its own module, mounted with the test chat on the canvas, so a picture uploads there
 * whether or not the Testing tab has been opened; a view test stands it in for one line.
 */
import { useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";

/** The gateway reads a test picture up to write_note's ceiling (`MAX_REMOTE_IMAGE_BYTES`, 5 MB). */
export const MAX_TEST_PIC_BYTES = 5_000_000;

export function usePicUpload(): (file: File) => Promise<{ url: string }> {
  const picUploadUrl = useMutation(api.functions.texSets.picUploadUrl);
  const picUrl = useMutation(api.functions.texSets.picUrl);
  return async (file) => {
    if (!/^image\/(png|jpeg|gif|webp|heic|heif)$/.test(file.type)) throw new Error("Pictures only: PNG, JPEG, GIF, WebP or HEIC");
    if (file.size > MAX_TEST_PIC_BYTES) throw new Error("That picture is over 5 MB");
    const res = await fetch(await picUploadUrl({}), { method: "POST", headers: { "Content-Type": file.type }, body: file });
    if (!res.ok) throw new Error("That picture did not upload");
    const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
    return { url: await picUrl({ storageId }) };
  };
}
