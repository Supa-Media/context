/**
 * Choose a picture for an emoji, on a phone. The library picker hands back the
 * bytes with the pick, for the reason `WorkspaceIconPicker` gives, and is
 * loaded only when somebody picks, for the reason it gives too.
 */

import { bytesFromBase64 } from "../files/imageBytes";

export async function pickEmojiFile(): Promise<{ fileName: string; bytes: ArrayBuffer } | null> {
  const ImagePicker = await import("expo-image-picker");
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, base64: true });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (asset === undefined || typeof asset.base64 !== "string") return null;
  return { fileName: asset.fileName ?? "emoji", bytes: bytesFromBase64(asset.base64) };
}
