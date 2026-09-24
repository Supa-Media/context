// @ts-check
/**
 * The plain text Modal a plugin fills and the console draws from its textContent.
 *
 * Moved verbatim out of `pluginSandboxDocument()` in ../sandbox.js; this is
 * source text for the sandboxed document, not code that runs in this realm.
 */
export const MODAL_JS = `  /*
    A DIALOG THE PLUGIN FILLS AND THE CONSOLE DRAWS.

    Same inversion as SuggestModal, one step simpler. contentEl and titleEl are
    real elements in here, so a plugin builds into them exactly as it would in
    Obsidian — including asynchronously, which Bible Reference's verse-of-the-day
    does: its onOpen awaits a fetch and only then calls contentEl.setText.

    So what crosses is text, and it crosses whenever the text changes rather
    than once when open() returns. A MutationObserver is what makes the async
    case work without polling and without the plugin having to tell us it
    finished — and without it this dialog would reliably show empty for the one
    plugin it was written for.

    Only textContent crosses. A plugin cannot put markup, a link, an image or a
    script in front of a reader, which is the same boundary the suggestion
    dialog keeps and for the same reason.

    Interactive controls built into contentEl do not work, and that is reported
    rather than hidden: a button drawn in here is a button in a document nobody
    sees. Read-only dialogs — a verse, a summary, an explanation — are what this
    serves, and they are most of them.
  */
  class Modal {
    constructor(appValue) {
      this.app = appValue;
      this.containerEl = createDiv();
      this.modalEl = this.containerEl.createDiv();
      this.titleEl = this.modalEl.createDiv();
      this.contentEl = this.modalEl.createDiv();
      this.__contextObserver = null;
    }
    setTitle(value) { this.titleEl.setText(value); this.__contextPush(); return this; }
    setContent(value) { this.contentEl.setText(value); this.__contextPush(); return this; }
    onOpen() {}
    onClose() {}
    open() {
      /*
        Retire whoever was open first. Its observer would otherwise keep running
        against a dialog nobody can see — __contextPush returns early once
        openTextModal moves on, so the callbacks are pure waste, and a plugin
        that opens a dialog per command would accumulate one each time.
      */
      if (openTextModal !== null && openTextModal !== this) openTextModal.__contextUnwatch();
      openTextModal = this;
      this.__contextWatch();
      // Sent before onOpen so a dialog whose content arrives over the network
      // appears immediately rather than after the round trip, which is what the
      // reader who pressed the command is waiting to see.
      this.__contextPush();
      try { Promise.resolve(this.onOpen()).then(() => this.__contextPush(), () => {}); } catch (_) {}
    }
    close() {
      // Unconditionally, before the early return: a modal that was replaced
      // rather than closed still owns an observer, and close() is a plugin's
      // only way to say it is finished with it.
      this.__contextUnwatch();
      if (openTextModal !== this) return;
      openTextModal = null;
      try { this.onClose(); } catch (_) {}
      send('text-modal', { open: false });
    }
    __contextWatch() {
      if (this.__contextObserver || typeof MutationObserver !== 'function') return;
      this.__contextObserver = new MutationObserver(() => this.__contextPush());
      this.__contextObserver.observe(this.modalEl, {
        childList: true, subtree: true, characterData: true,
      });
    }
    __contextUnwatch() {
      if (!this.__contextObserver) return;
      this.__contextObserver.disconnect();
      this.__contextObserver = null;
    }
    __contextPush() {
      if (openTextModal !== this) return;
      send('text-modal', {
        open: true,
        title: String(this.titleEl.textContent || '').slice(0, TEXT_MODAL_TITLE_MAX),
        text: String(this.contentEl.textContent || '').slice(0, TEXT_MODAL_TEXT_MAX),
      });
    }
  }


`;
