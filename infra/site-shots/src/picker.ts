/**
 * Page code for putting one of the person's files into a page: the file box
 * the step names, a stand-in for the device's file picker while a button is
 * pressed, or a drop. Every piece writes the file in as data, never as code.
 *
 * With a browser that can be given a real file (Browserbase, ./upload.ts),
 * the box is only marked here, with a mark made fresh for each step, and the
 * browser itself sets the file on it; the in-page DataTransfer is the way in
 * when it cannot.
 */

/** The element a reading numbered, by its number. */
export const refSelector = (ref: number) => `[data-tex-ref="${ref}"]`;
const selector = refSelector;

/**
 * A file the gateway read from the person's own notes or mail (`apps/mcp/src/agent/uploads.js`),
 * put into the page's upload box the way a person picking it would.
 */
export interface UploadFile {
  name: string;
  type: string;
  /** base64 */
  data: string;
}

/**
 * A browser that can be given a real file, the way the device's own picker
 * gives one (./upload.ts): `stage` puts the file on the browser's own disk and
 * answers its path there, for a document's `setFiles` (./frames.ts).
 */
export interface Uploads {
  stage(file: UploadFile): Promise<string>;
  /** How a file went in: by the browser, or from the page. Logged, never the file. */
  said(via: "browser" | "page"): void;
}

/** The attribute a box the person's file goes into is marked with, for the browser to find it. */
export const FILE_BOX_MARK = "data-tex-file-box";
/** The marked box, by this step's mark. */
export const markedSelector = (mark: string) => `[${FILE_BOX_MARK}="${mark}"]`;
const MARK = /^[a-z0-9]{8,64}$/;
function markSource(mark: string): string {
  if (!MARK.test(mark)) throw new Error("bad mark");
  return `box.setAttribute(${JSON.stringify(FILE_BOX_MARK)}, ${JSON.stringify(mark)});`;
}

/** Page code that makes `transfer`, a DataTransfer holding the person's file, written in as data. */
function transferSource(file: UploadFile): string {
  return `const binary = atob(${JSON.stringify(file.data)});
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], ${JSON.stringify(file.name)}, { type: ${JSON.stringify(file.type)} }));`;
}

/**
 * Put a file into the page as a person choosing it would: into the file box
 * the step names, the one inside or beside it, or the page's only one, with
 * the events a page listens for. Answers "input"; "button" when the element
 * named has no box near it, so pressing it is what asks for the file (an app
 * that makes its box only when pressed); "none" with nothing to go on. Given
 * a mark instead of a file, the box is only marked, for the browser to fill.
 */
export function uploadSource(ref: number | null, file: UploadFile | { mark: string }): string {
  const put = "mark" in file
    ? markSource(file.mark)
    : `box.files = transfer.files;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));`;
  return `(() => {
  const named = ${ref === null ? "null" : `document.querySelector('${selector(ref)}')`};
  ${"mark" in file ? "" : transferSource(file)}
  const isBox = (el) => !!el && el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "file";
  const boxes = [...document.querySelectorAll("input[type=file]")];
  let box = isBox(named) ? named : null;
  if (!box && named) box = named.querySelector("input[type=file]") || (named.closest("form, label, [role=dialog]") || document.body).querySelector("input[type=file]");
  if (!box && !named && boxes.length > 0) box = boxes[0];
  if (box) {
    ${put}
    return "input";
  }
  return named ? "button" : "none";
})()`;
}

/**
 * Stand in for the device's file picker until `pickerResult` is read. A
 * remote browser's picker opens where nobody can answer it, so a file box the
 * page opens (its own `click()` or `showPicker()`, or a press on a label for
 * one) gets the person's file instead, as choosing it would; with no file,
 * the press is only noted: that element asks for one; with a mark, the box
 * is marked for the browser to fill.
 */
export function pickerHookSource(file: UploadFile | { mark: string } | null): string {
  const take =
    file === null
      ? `state.got = "asked";`
      : "mark" in file
      ? `${markSource(file.mark)}
    state.got = "attached";`
      : `${transferSource(file)}
    box.files = transfer.files;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
    state.got = "attached";`;
  return `(() => {
  if (window.__texPicker) window.__texPicker.restore();
  const proto = HTMLInputElement.prototype;
  const click = proto.click, show = proto.showPicker;
  const isBox = (el) => el instanceof HTMLInputElement && (el.getAttribute("type") || "").toLowerCase() === "file";
  const state = { got: "none" };
  const take = (box) => {
    ${take}
  };
  proto.click = function () { if (isBox(this)) { take(this); return; } return click.call(this); };
  if (show) proto.showPicker = function () { if (isBox(this)) { take(this); return; } return show.call(this); };
  const pressed = (event) => {
    const target = event.target;
    const label = target && target.closest ? target.closest("label") : null;
    const box = isBox(target) ? target : label ? label.control : null;
    if (isBox(box)) { event.preventDefault(); take(box); }
  };
  document.addEventListener("click", pressed, true);
  state.restore = () => {
    proto.click = click;
    if (show) proto.showPicker = show;
    document.removeEventListener("click", pressed, true);
    delete window.__texPicker;
  };
  window.__texPicker = state;
})()`;
}

/**
 * What the stand-in picker saw ("attached", "asked" or "none"), and puts the
 * real one back. An upload waits up to `waitMs` for a page that opens its box
 * late; a click does not wait, so pressing a button costs nothing more.
 */
export function pickerResult(waitMs: number): string {
  return `new Promise((done) => {
  let waited = 0;
  const check = () => {
    const state = window.__texPicker;
    if (!state || state.got !== "none" || waited >= ${waitMs}) {
      const got = state ? state.got : "none";
      if (state) state.restore();
      done(got);
      return;
    }
    waited += 250;
    setTimeout(check, 250);
  };
  check();
})`;
}

/** Drop the file onto the element, as dragging it there would: the last way in, for a page with only a drop zone. */
export function dropSource(ref: number, file: UploadFile): string {
  return `(() => {
  const named = document.querySelector('${selector(ref)}');
  if (!named) return false;
  ${transferSource(file)}
  for (const kind of ["dragenter", "dragover", "drop"]) {
    named.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }
  return true;
})()`;
}


/** How many bytes the file is, from its base64. */
export const sizeOf = (file: UploadFile) => Math.floor((file.data.length * 3) / 4) - (/=*$/.exec(file.data)?.[0].length ?? 0);

/** The size of the one file the marked box holds, or -1: whether the browser's copy arrived. */
export function markedSizeSource(mark: string): string {
  if (!MARK.test(mark)) throw new Error("bad mark");
  return `(() => {
  const box = document.querySelector('${markedSelector(mark)}');
  return box && box.files && box.files.length === 1 ? box.files[0].size : -1;
})()`;
}

/** Put the file into the marked box from the page: the way in when the browser could not set it itself. */
export function fillMarkedSource(mark: string, file: UploadFile): string {
  if (!MARK.test(mark)) throw new Error("bad mark");
  return `(() => {
  const box = document.querySelector('${markedSelector(mark)}');
  if (!box) return false;
  ${transferSource(file)}
  box.files = transfer.files;
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`;
}
