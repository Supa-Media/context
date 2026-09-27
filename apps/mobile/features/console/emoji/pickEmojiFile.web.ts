/**
 * Choose a picture for an emoji, in a browser: the file exactly as it is on
 * disk, so an animated GIF stays animated. (The native picker re-encodes.)
 */

export async function pickEmojiFile(): Promise<{ fileName: string; bytes: ArrayBuffer } | null> {
  if (typeof document === "undefined") return null;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/gif,image/webp";
  const file = await new Promise<File | null>((resolve) => {
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
  if (file === null) return null;
  return { fileName: file.name, bytes: await file.arrayBuffer() };
}
