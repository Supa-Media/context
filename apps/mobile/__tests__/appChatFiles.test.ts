import { describe, expect, test } from "@jest/globals";
import { encodeFiles, saveBlob, type PickedFile } from "../features/tex/chat/appChatFiles";
import { MAX_FILE_BYTES } from "../features/tex/chat/appChatGateway";

/** A picked file: a Blob that carries the name a picker gives a File. */
function picked(parts: BlobPart[], name: string): PickedFile {
  return Object.assign(new Blob(parts), { name }) as PickedFile;
}

describe("encodeFiles", () => {
  test("each file goes as its name and its bytes in base64, in order", async () => {
    expect(await encodeFiles([])).toEqual([]);
    expect(await encodeFiles([picked(["hi"], "a.txt"), picked(["a,b\n"], "b.csv")])).toEqual([
      { name: "a.txt", data: "aGk=" },
      { name: "b.csv", data: "YSxiCg==" },
    ]);
  });

  test("a file over 10 MB is not encoded at all", async () => {
    const big = picked([new Uint8Array(MAX_FILE_BYTES + 1)], "big.pdf");
    expect(await encodeFiles([picked(["ok"], "a.txt"), big])).toBeNull();
  });
});

describe("saveBlob", () => {
  test("where there is no document to click a link in, nothing is saved and the answer says so", () => {
    expect(saveBlob(new Blob(["x"]), "a.txt")).toBe(false);
  });
});
