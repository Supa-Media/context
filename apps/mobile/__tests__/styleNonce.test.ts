/**
 * @jest-environment jsdom
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { pageStyleNonce, STYLE_NONCE_SOURCE_ID } from "../features/console/files/liveEditorWeb/styleNonce";

function shellStyle(nonce: string | null): void {
  document.head.innerHTML = "";
  const style = document.createElement("style");
  style.id = STYLE_NONCE_SOURCE_ID;
  if (nonce !== null) style.setAttribute("nonce", nonce);
  document.head.append(style);
}

describe("the editor takes the served page's style nonce, and invents none", () => {
  it("reads the shell style's nonce", () => {
    shellStyle("cmFuZG9tLXBlci1yZXNwb25zZQ==");
    expect(pageStyleNonce()).toBe("cmFuZG9tLXBlci1yZXNwb25zZQ==");
  });

  it("is empty for a page served without one, which is every page today", () => {
    shellStyle(null);
    expect(pageStyleNonce()).toBe("");
    document.head.innerHTML = "";
    expect(pageStyleNonce()).toBe("");
  });

  it("ignores an element of another kind wearing the id", () => {
    document.head.innerHTML = "";
    const decoy = document.createElement("div");
    decoy.id = STYLE_NONCE_SOURCE_ID;
    decoy.setAttribute("nonce", "planted");
    document.head.append(decoy);
    expect(pageStyleNonce()).toBe("");
  });

  it("puts the nonce on CodeMirror's own style element", () => {
    shellStyle("ZnJlc2g=");
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: "x", extensions: [EditorView.cspNonce.of(pageStyleNonce())] }),
      parent,
    });
    const mounted = [...document.querySelectorAll("style")].filter((style) => style.id !== STYLE_NONCE_SOURCE_ID);
    expect(mounted.length).toBeGreaterThan(0);
    for (const style of mounted) expect(style.getAttribute("nonce")).toBe("ZnJlc2g=");
    view.destroy();
  });
});
