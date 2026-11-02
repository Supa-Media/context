/**
 * Comments on a page: the same threads, in the same `comments` block, as
 * comments on the note in the editor (`@context/shared/src/comments.cjs`).
 *
 * The frame reads the threads from the note it was handed, highlights the
 * words of each open one, and draws a thread when its words are clicked.
 * Selecting words offers a Comment button. Nothing here writes: every new
 * comment, reply and resolve is a message to the app, which checks the range
 * against the note it holds now and writes the anchor and the log line as the
 * signed-in person (`pageView/pageHost.ts`).
 */

import comments from "@context/shared/src/comments.cjs";

const MAX_BODY = 4000;

export function bindComments({ root, pages, tell, state, page, reportHeight }) {
  let floating = null;

  const close = () => {
    if (floating) floating.remove();
    floating = null;
  };

  /** A point in the page as a position in the note, or null when it is not inside a run of words. */
  function sourceAt(node, offset) {
    const element = node.nodeType === 3 ? node.parentElement : node;
    const span = element && element.closest("[data-f]");
    if (!span || !root.contains(span)) return null;
    let seen = 0;
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (text === node) return pages.sourceOffset(state().source, Number(span.dataset.f), Number(span.dataset.t), seen + offset);
      seen += text.data.length;
    }
    return node === span ? pages.sourceOffset(state().source, Number(span.dataset.f), Number(span.dataset.t), offset === 0 ? 0 : seen) : null;
  }

  function place(box, rect) {
    const top = rect.bottom + window.scrollY + 8;
    const left = Math.max(8, Math.min(rect.left + window.scrollX, document.documentElement.clientWidth - box.offsetWidth - 8));
    box.style.top = `${top}px`;
    box.style.left = `${left}px`;
  }

  function composer(rect, label, onSend) {
    close();
    const box = document.createElement("div");
    box.className = "pg-pop";
    box.innerHTML = `<textarea rows="3" maxlength="${MAX_BODY}" placeholder="${label}"></textarea><div class="pg-pop-row"><button type="button" data-cancel>Cancel</button><button type="button" data-send class="pg-primary">Comment</button></div>`;
    document.body.appendChild(box);
    place(box, rect);
    const area = box.querySelector("textarea");
    area.focus();
    box.querySelector("[data-cancel]").addEventListener("click", close);
    box.querySelector("[data-send]").addEventListener("click", () => {
      const body = area.value.trim();
      if (body === "") return;
      onSend(body);
      close();
    });
    floating = box;
  }

  function offerComment() {
    if (!state().canComment) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    const from = sourceAt(range.startContainer, range.startOffset);
    const to = sourceAt(range.endContainer, range.endOffset);
    if (from === null || to === null || to <= from) return;
    const quote = range.toString().trim().slice(0, 300);
    const rect = range.getBoundingClientRect();
    close();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pg-pop pg-comment-button";
    button.textContent = "Comment";
    document.body.appendChild(button);
    place(button, rect);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => composer(rect, "Add a comment", (body) => tell({ type: "comment", from, to, quote, body })));
    floating = button;
  }

  function showThread(id, rect) {
    const thread = comments.parseComments(state().source).threads.find((t) => t.id === id);
    if (!thread) return;
    close();
    const box = document.createElement("div");
    box.className = "pg-pop pg-thread";
    const events = thread.events
      .filter((event) => event.kind === "comment")
      .map((event) => {
        const who = document.createElement("div");
        who.className = "pg-msg";
        const name = document.createElement("b");
        name.textContent = event.author;
        const text = document.createElement("span");
        text.textContent = event.text;
        who.append(name, text);
        return who;
      });
    box.append(...events);
    if (state().canComment) {
      const area = document.createElement("textarea");
      area.rows = 2;
      area.maxLength = MAX_BODY;
      area.placeholder = "Reply";
      const row = document.createElement("div");
      row.className = "pg-pop-row";
      const resolve = document.createElement("button");
      resolve.type = "button";
      resolve.textContent = "Resolve";
      resolve.addEventListener("click", () => {
        tell({ type: "resolve", thread: id });
        close();
      });
      const send = document.createElement("button");
      send.type = "button";
      send.className = "pg-primary";
      send.textContent = "Reply";
      send.addEventListener("click", () => {
        const body = area.value.trim();
        if (body === "") return;
        tell({ type: "reply", thread: id, body });
        close();
      });
      row.append(resolve, send);
      box.append(area, row);
    }
    document.body.appendChild(box);
    place(box, rect);
    floating = box;
    reportHeight();
  }

  document.addEventListener("mouseup", () => setTimeout(offerComment, 0));
  document.addEventListener("keyup", (event) => {
    if (event.shiftKey) offerComment();
  });
  document.addEventListener("touchend", () => setTimeout(offerComment, 250));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  document.addEventListener("mousedown", (event) => {
    if (floating && !floating.contains(event.target)) close();
  });
  root.addEventListener("click", (event) => {
    const marked = event.target.closest(".pg-c");
    if (!marked || event.target.isContentEditable && window.getSelection().toString() !== "") return;
    const id = (marked.dataset.a || "").split(" ")[0];
    if (id) showThread(id, marked.getBoundingClientRect());
  });

  return {
    threads: (source) => comments.parseComments(source).threads,
    refresh: () => close(),
    page,
  };
}
