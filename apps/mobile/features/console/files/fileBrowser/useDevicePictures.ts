/**
 * Pictures on this device: shown offline, pasted offline, and sent when the
 * connection is back (owner, 2026-11-09, approving the offline-first boards:
 * "pictures kept on the phone").
 *
 * Wraps `loadImage` and `storeImage` from `useWritesAndImages`, which run
 * before the offline queue exists in `useFileBrowser`'s order, so the device
 * half is added here, after it. Online, both go to the server as before, and
 * a picture the server shows is also kept here (`devicePictures.ts`).
 * Offline, a picture is read from what this device kept, and a paste is kept
 * here and named as the server will name it, so the note embeds it at once.
 *
 * **A picture the server refuses is never answered from the device.** The
 * device copy is read only when this device is known to be offline: online,
 * a refusal (the note was unshared, the picture is gone) stands, rather than
 * a copy from before it being drawn in its place.
 */
/* eslint-disable react-hooks/exhaustive-deps -- refs and the earlier parts'
   stable callbacks arrive through `deps`, as in every part of this hook. */
import { useCallback, useEffect } from "react";
import { pictureLeaf, pictureSrc } from "../../../offline/devicePictures";
import { isRemoteImageTarget } from "../imageBytes";
import { EMOJI_IMAGE_TARGET } from "../emoji/host";
import { compressPastedPicture } from "./compressPastedPicture";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { WritesAndImagesValues } from "./useWritesAndImages";

type DevicePicturesDeps =
  & Pick<FileActionsValues, "imageCache" | "storeNoteImageAction" | "workspaceId">
  & Pick<BrowserStateValues, "editorRef">
  & Pick<WritesAndImagesValues, "loadImage" | "storeImage">
  & Pick<OfflineQueueValues, "offline" | "offlineRef">;

export function useDevicePictures(deps: DevicePicturesDeps) {
  const { editorRef, imageCache, loadImage: fromServer, offline, offlineRef, storeImage: toServer, storeNoteImageAction, workspaceId } = deps;

  const loadImage = useCallback(
    async (target: string): Promise<string | null> => {
      // An emoji and a proxied remote image are not this workspace's pictures.
      if (workspaceId === null || target.startsWith(EMOJI_IMAGE_TARGET) || isRemoteImageTarget(target)) {
        return fromServer(target);
      }
      const key = `${workspaceId}|${target}`;
      const cached = imageCache.current.get(key);
      if (cached !== undefined) return cached;
      const device = offlineRef.current;
      if (device.reachability === "offline") {
        const kept = await device.devicePicture(target);
        if (kept !== null) imageCache.current.set(key, kept);
        return kept;
      }
      const src = await fromServer(target);
      if (src !== null) device.keepPicture(target, src);
      return src;
    },
    [fromServer, workspaceId],
  );

  const storeImage = useCallback(
    async (image: { bytes: ArrayBuffer; contentType: string }): Promise<{ target: string } | { error: string }> => {
      const device = offlineRef.current;
      // Online, encrypted (refused there, in its own words), or a tab that keeps no copy: the server's answer.
      if (workspaceId === null || device.reachability !== "offline" || device.deviceFirst !== true || editorRef.current.encrypted) {
        return toServer(image);
      }
      const picture = await compressPastedPicture({ bytes: image.bytes, contentType: image.contentType });
      const leaf = await pictureLeaf(picture.bytes, picture.contentType);
      if (leaf === null) return { error: "That is not an image type this store accepts." };
      const src = pictureSrc(picture.bytes, picture.contentType);
      if (!(await device.queuePicture({ leaf, src, contentType: picture.contentType }))) {
        return { error: "This picture could not be kept on this device. Try again once you are back online." };
      }
      imageCache.current.set(`${workspaceId}|${leaf}`, src);
      return { target: leaf };
    },
    [toServer, workspaceId],
  );

  /*
    Back online: every picture pasted here goes up, through the same action a
    paste online uses, which names it from the same bytes the same way.
  */
  const reachability = offline.reachability;
  useEffect(() => {
    if (reachability !== "online" || workspaceId === null) return;
    void offlineRef.current
      .sendPictures(async ({ bytes, contentType }) => (await storeNoteImageAction({ workspaceId, bytes, contentType })).leaf)
      .catch(() => {});
  }, [reachability, workspaceId]);

  return { loadImage, storeImage };
}
