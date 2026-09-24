// @ts-check
/**
 * The view classes a plugin is handed: MarkdownView, ItemView, EditorSuggest, SuggestModal and FuzzySuggestModal.
 *
 * Moved verbatim out of `pluginSandboxDocument()` in ../sandbox.js; this is
 * source text for the sandboxed document, not code that runs in this realm.
 */
export const VIEWS_JS = `  /*
    The view a plugin is handed for the open note.

    Obsidian's carries a leaf, a mode, a preview renderer and its own DOM; this
    carries the two members every "write into the current note" path actually
    uses — file and editor — plus the handful of methods that read them. It is a
    real class rather than an object literal because plugins test what they are
    given with instanceof, and getActiveViewOfType answers null for any other
    type asked for.
  */
  class MarkdownView {
    constructor(appValue, target, editor) {
      this.app = appValue;
      this.file = target === undefined ? null : target;
      this.editor = editor === undefined ? null : editor;
      this.containerEl = createDiv();
      this.contentEl = createDiv();
    }
    getViewType() { return 'markdown'; }
    // Source, always: the console's editor is a text editor, and a plugin that
    // branches on the mode should take the branch that writes Markdown.
    getMode() { return 'source'; }
    getDisplayText() { return this.file === null ? '' : this.file.basename; }
    getViewData() { return this.editor === null ? '' : this.editor.getValue(); }
    setViewData(value) { if (this.editor !== null) this.editor.setValue(value); }
    // The write-back happens when the work finishes, so a plugin asking for a
    // save has already had one arranged rather than needing one now.
    save() { return Promise.resolve(); }
  }
  class ItemView {}
  class EditorSuggest { constructor(appValue) { this.app = appValue; } }

  /*
    A SUGGESTION DIALOG, BY THE SAME INVERSION AS registerEditorSuggest.

    Obsidian's SuggestModal builds and mounts its own dialog. Context cannot let
    it — that is third-party DOM in the trusted realm, which plugins.md rules
    out — so the halves are split exactly as they are for an editor suggestion,
    and for the same reasons: the plugin's getSuggestions and renderSuggestion
    run *in here*, against elements created in here, and only the resulting text
    crosses. The console draws its own dialog and sends back an index.

    **It exists at all because absent was worse than inverted.** class X extends
    api.SuggestModal {} is evaluated when a bundle loads, so a missing class was
    not a missing feature — it was extends undefined, thrown before onload, and
    the whole plugin gone. Bible Reference is the one that showed it: its inline
    verse suggester needs nothing that was not already built, and it never got to
    register it.

    onChooseSuggestion runs in here too, which is the point — that is where a
    plugin does its work, and it reaches the vault through the same grants
    everything else does.
  */
  class SuggestModal {
    constructor(appValue) {
      this.app = appValue;
      this.limit = SUGGEST_MAX;
      this.placeholder = '';
      this.instructions = [];
    }
    setPlaceholder(text) { this.placeholder = String(text == null ? '' : text).slice(0, 120); }
    setInstructions(list) {
      this.instructions = (Array.isArray(list) ? list : []).slice(0, 6).map((row) => ({
        command: String((row && row.command) || '').slice(0, 40),
        purpose: String((row && row.purpose) || '').slice(0, 120),
      }));
    }
    // Obsidian calls these on the plugin's behalf; a subclass may override
    // either. Empty here rather than absent so super.onOpen() works.
    onOpen() {}
    onClose() {}
    getSuggestions() { return []; }
    renderSuggestion() {}
    onChooseSuggestion() {}
    open() {
      openModal = { modal: this, values: [] };
      try { this.onOpen(); } catch (_) {}
      send('suggest-modal', {
        open: true,
        placeholder: this.placeholder,
        instructions: this.instructions,
      });
    }
    close() {
      if (openModal === null || openModal.modal !== this) return;
      openModal = null;
      try { this.onClose(); } catch (_) {}
      send('suggest-modal', { open: false, placeholder: '', instructions: [] });
    }
  }

  /*
    The fuzzy variant, which most plugins actually reach for. Obsidian wraps each
    item as { item, match } and calls getItemText / onChooseItem; the
    default filter here is a plain case-insensitive substring rather than a
    scoring one, because a wrong *order* is a worse answer that still looks
    right, and nothing here promises Obsidian's ranking.
  */
  class FuzzySuggestModal extends SuggestModal {
    getItems() { return []; }
    getItemText() { return ''; }
    onChooseItem() {}
    getSuggestions(query) {
      const needle = String(query || '').toLowerCase();
      const matches = [];
      for (const item of this.getItems()) {
        const text = String(this.getItemText(item) || '');
        if (needle === '' || text.toLowerCase().includes(needle)) matches.push({ item, match: { score: 0, matches: [] } });
      }
      return matches;
    }
    renderSuggestion(value, el) { el.textContent = String(this.getItemText(value && value.item)); }
    onChooseSuggestion(value, evt) { this.onChooseItem(value && value.item, evt); }
  }
`;
