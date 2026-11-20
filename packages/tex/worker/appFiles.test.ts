import { describe, expect, it } from "vitest";
import { appFileIdOf, appFileUrl, forgetAppFile, keepAppFile, readAppFile, safeAppFileName, serveAppFile, sniffAppFile } from "./appFiles";
import { prepareAttachments } from "./attachments";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";

const enc = (text: string) => new TextEncoder().encode(text);
const PDF = enc("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
const CSV = enc("name,amount\nAma,3\n");
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...enc("[Content_Types].xml word/document.xml")]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
const HTML_WITH_NUL = new Uint8Array([...enc("<html><script>alert(1)</script></html>"), 0x00]);
const ID = /^[0-9a-f]{32}$/;

describe("an app chat's files: the bytes and the name decide the kind", () => {
  it("keeps a PDF, a CSV, a text, Markdown, TSV, JSON and a Word file, each as its kind", async () => {
    const storage = new MemoryStorage();
    const cases: [Uint8Array, string, string][] = [
      [PDF, "report.pdf", "application/pdf"],
      [CSV, "sheet.csv", "text/csv"],
      [enc("plain words"), "note.txt", "text/plain"],
      [enc("# Title\n"), "note.md", "text/markdown"],
      [enc("a\tb\n"), "table.tsv", "text/tab-separated-values"],
      [enc('{"a":1}'), "data.json", "application/json"],
      [ZIP, "letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ];
    for (const [bytes, name, type] of cases) {
      const id = await keepAppFile(storage, bytes, name, 1);
      expect(id).toMatch(ID);
      const kept = await readAppFile(storage, id!);
      expect(kept?.mediaType).toBe(type);
      expect(kept?.name).toBe(name);
      expect(new Uint8Array(kept!.bytes)).toEqual(bytes);
    }
  });

  it("refuses an .exe, HTML named .html, and HTML bytes with a NUL named .txt", async () => {
    const storage = new MemoryStorage();
    expect(await keepAppFile(storage, EXE, "setup.exe", 1)).toBeNull();
    expect(await keepAppFile(storage, enc("<html></html>"), "page.html", 1)).toBeNull();
    expect(await keepAppFile(storage, HTML_WITH_NUL, "a.txt", 1)).toBeNull();
    expect(await keepAppFile(storage, EXE, "a.txt", 1)).toBeNull();
    expect(await keepAppFile(storage, enc("ok"), "a.exe", 1)).toBeNull();
  });

  it("refuses bytes that are not valid UTF-8 as a text file", () => {
    expect(sniffAppFile(new Uint8Array([0xff, 0xfe, 0xfd]), "a.csv")).toBeNull();
    expect(sniffAppFile(enc("fine"), "a.csv")).toBe("text/csv");
  });

  it("takes a zip as a Word file only when it is named .docx, and a PDF only when named .pdf", () => {
    expect(sniffAppFile(ZIP, "a.docx")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(sniffAppFile(ZIP, "a.txt")).toBeNull();
    expect(sniffAppFile(ZIP, "a.pdf")).toBeNull();
    expect(sniffAppFile(ZIP, "a")).toBeNull();
    expect(sniffAppFile(PDF, "a.docx")).toBeNull();
    expect(sniffAppFile(PDF, "a.txt")).toBeNull();
    expect(sniffAppFile(PDF, "a.pdf")).toBe("application/pdf");
  });

  it("refuses an empty file and one over 10 MB", async () => {
    const storage = new MemoryStorage();
    expect(await keepAppFile(storage, new Uint8Array(0), "a.txt", 1)).toBeNull();
    expect(await keepAppFile(storage, new Uint8Array(10_000_001).fill(0x61), "a.txt", 1)).toBeNull();
    expect(await keepAppFile(storage, new Uint8Array(10_000_000).fill(0x61), "a.txt", 1)).toMatch(ID);
  });
});

describe("an app chat's file names", () => {
  it("strips path parts, so a traversal name is only its last part", () => {
    expect(safeAppFileName("../../x.pdf")).toBe("x.pdf");
    expect(safeAppFileName("..\\..\\x.pdf")).toBe("x.pdf");
    expect(safeAppFileName("/etc/passwd")).toBe("passwd");
    expect(safeAppFileName("..")).toBe("file");
    expect(safeAppFileName("   ")).toBe("file");
  });

  it("drops control and format characters, such as a right-to-left override that would hide an extension", () => {
    expect(safeAppFileName("a\u0000b\u0007.pdf")).toBe("ab.pdf");
    expect(safeAppFileName("evil‮fdp.exe")).toBe("evilfdp.exe");
  });

  it("keeps at most 120 characters, and the extension when it cuts", () => {
    const long = `${"a".repeat(300)}.pdf`;
    const safe = safeAppFileName(long);
    expect(safe.length).toBe(120);
    expect(safe.endsWith(".pdf")).toBe(true);
  });

  it("a name the kind check cannot use is refused, not given a type from its label", async () => {
    const storage = new MemoryStorage();
    expect(await keepAppFile(storage, PDF, "../../evil.exe", 1)).toBeNull();
  });
});

describe("an app chat's kept file, read by its id", () => {
  it("answers its bytes and kind only for an id it keeps, and 404 for any other address", async () => {
    const storage = new MemoryStorage();
    const id = (await keepAppFile(storage, CSV, "sheet.csv", 1))!;
    const url = appFileUrl(id, "sheet.csv");
    expect(url).toBe(`https://app-chat.invalid/file/${id}/sheet.csv`);
    expect(appFileIdOf(url)).toBe(id);
    const served = await serveAppFile(storage, url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("text/csv");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(CSV);
    expect((await serveAppFile(storage, `https://app-chat.invalid/file/${"a".repeat(32)}/x.csv`)).status).toBe(404);
    expect((await serveAppFile(storage, "https://example.test/file/x.csv")).status).toBe(404);
    expect(await readAppFile(storage, "../evil")).toBeNull();
  });

  it("keeps a file over one stored value in pieces, and deletes every piece when taken back", async () => {
    const storage = new MemoryStorage();
    const big = new Uint8Array(4_000_000).fill(0x61);
    big[3_999_999] = 0x0a;
    const id = (await keepAppFile(storage, big, "big.txt", 1))!;
    const kept = await readAppFile(storage, id);
    expect(kept?.bytes.byteLength).toBe(4_000_000);
    expect(kept?.bytes[3_999_999]).toBe(0x0a);
    await forgetAppFile(storage, id);
    expect(await readAppFile(storage, id)).toBeNull();
    expect([...(await storage.list({ prefix: "app:file" })).keys()]).toEqual([]);
  });
});

describe("a turn reads an app chat's file the way it reads one texted over iMessage", () => {
  it("hands a kept PDF to the model as a document and a kept CSV as its words", async () => {
    const storage = new MemoryStorage();
    const pdfId = (await keepAppFile(storage, PDF, "report.pdf", 1))!;
    const csvId = (await keepAppFile(storage, CSV, "sheet.csv", 1))!;
    const fetch = ((url: string) => serveAppFile(storage, url)) as unknown as Fetch;
    const [pdf, csv] = await prepareAttachments(
      [
        { url: appFileUrl(pdfId, "report.pdf"), mimeType: "application/pdf", filename: "report.pdf", size: PDF.byteLength },
        { url: appFileUrl(csvId, "sheet.csv"), mimeType: "text/csv", filename: "sheet.csv", size: CSV.byteLength },
      ],
      { fetch },
    );
    expect(pdf).toMatchObject({ name: "report.pdf", mediaType: "application/pdf" });
    expect("data" in pdf!).toBe(true);
    expect(csv).toEqual({ name: "sheet.csv", mediaType: "text/csv", text: "name,amount\nAma,3\n" });
  });
});
