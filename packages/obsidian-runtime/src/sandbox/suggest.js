// @ts-check
/**
 * Editor suggestions: the host asks the guest to suggest over one line, and only rendered text crosses back.
 *
 * Moved verbatim out of `pluginSandboxDocument()` in ../sandbox.js; this is
 * source text for the sandboxed document, not code that runs in this realm.
 */
export const SUGGEST_JS = `  /*
    EDITOR SUGGESTIONS: A ROUND TRIP OVER ONE LINE, AND NOTHING ELSE CROSSES.

    registerEditorSuggest is how a plugin offers an in-editor completion —
    YouVersion Linker's whole primary interaction, the list you get from typing
    @ John 1:1. Obsidian mounts the suggester into its editor; Context cannot,
    because that puts third-party callbacks and DOM in the trusted realm, which
    docs/decisions/plugins.md rules out.

    So the interaction is inverted. The host asks *"here is the line and where
    the cursor is — do you want to suggest?"*; the guest runs the plugin's own
    onTrigger and getSuggestions against a one-line editor, renders each
    suggestion into an element **in here**, and reports what those elements say.
    The host draws its own list. On a pick, the plugin's selectSuggestion runs
    against the same one-line editor and the guest reports the line it produced
    — the *trusted editor* then makes that edit through its own editing path.

    Two consequences worth stating, because they are the reason this shape was
    chosen over the obvious one:

    - **A suggester needs no write grant.** The edit is the person typing, made
      by their own editor, undoable like anything else they typed. Nothing here
      touches vault.modify.
    - **The line is note content**, so the *host* decides whether a plugin may
      be asked at all. That gate is maySeeContent on the trusted side; the
      guest cannot be trusted to filter what it is handed.
  */
  const suggesters = [];
  const SUGGEST_MAX = 8;
  // The offer the last query produced: which suggester made it, the values it
  // returned, and the editor it was computed against. Replaced by the next
  // query, so an apply can only ever land on what is currently on screen.
  let offered = null;
  /*
    The dialog a plugin has open, if any: the modal itself and the values its
    last query produced. One at a time, replaced by the next open(), so a pick
    can only ever land on what is currently on screen — the rule offered keeps
    for the editor's own suggestions, applied to this.
  */
  let openModal = null;
  /*
    The plain text dialog a plugin has open, if any. Separate from openModal
    because they are different dialogs with different protocols — one asks the
    reader to choose, one only shows them something — and one variable for both
    would make close() have to guess which it was closing.
  */
  let openTextModal = null;
  const TEXT_MODAL_TITLE_MAX = 200;
  /*
    Enough for a passage, and a ceiling rather than a guess: what crosses is one
    postMessage per mutation of the dialog's own DOM, so a plugin that builds a
    large document into contentEl would otherwise send it repeatedly.
  */
  const TEXT_MODAL_TEXT_MAX = 8000;

  async function answerSuggest(message) {
    const line = typeof message.line === 'string' ? message.line : '';
    const ch = Math.max(0, Math.min(line.length, Number(message.ch) || 0));
    /*
      The caret goes where the host says it is, rather than being left at the
      end by default. What arrives is the line up to the caret, so the two are
      the same position today — and they stop being the same the moment the
      host sends more of the line, which is exactly the kind of change that
      should not quietly move a plugin's insertion point.
    */
    const editor = editorFor(line, ch);
    const cursor = { line: 0, ch };
    offered = null;
    for (const suggester of suggesters) {
      let context = null;
      try { context = suggester.onTrigger(cursor, editor, activeFile); } catch (_) { context = null; }
      if (!context) continue;
      suggester.context = Object.assign({ editor, file: activeFile }, context);
      let values = [];
      try { values = await suggester.getSuggestions(suggester.context); } catch (_) { values = []; }
      if (!Array.isArray(values)) values = [];
      const items = [];
      for (const value of values.slice(0, SUGGEST_MAX)) {
        const el = document.createElement('div');
        try { suggester.renderSuggestion(value, el); } catch (_) {}
        const text = String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
        items.push({ text });
      }
      offered = { suggester, values: values.slice(0, SUGGEST_MAX), editor, line };
      send('suggest-results', { seq: message.seq, items });
      return;
    }
    send('suggest-results', { seq: message.seq, items: [] });
  }

  async function applySuggest(message) {
    if (offered === null) return;
    const index = Number(message.index);
    const value = offered.values[index];
    if (value !== undefined) {
      // Awaited directly rather than through settleEditorWork: a selection is
      // one edit on one line, and the loop that exists for a command's network
      // round trips would make a keystroke wait on timers it does not need.
      // An async selectSuggestion still resolves here; a throwing one is the
      // plugin's failure and leaves the line as it was.
      try { await offered.suggester.selectSuggestion(value, {}); } catch (_) {}
    }
    send('suggest-applied', { seq: message.seq, line: offered.editor.getValue().slice(0, 4000) });
  }

  /*
    What the open dialog would show for this query.

    The same shape as answerSuggest: the plugin's own getSuggestions runs in
    here, each value is rendered into an element in here, and only the text
    those elements carry is sent. limit is the plugin's own if it set one,
    clamped, because a plugin asking for three hundred rows is still a list the
    console has to draw.
  */
  async function answerModal(message) {
    const query = typeof message.query === 'string' ? message.query.slice(0, 200) : '';
    const modal = openModal.modal;
    let values = [];
    try { values = await modal.getSuggestions(query); } catch (_) { values = []; }
    if (!Array.isArray(values)) values = [];
    const limit = Math.max(1, Math.min(SUGGEST_MAX, Number(modal.limit) || SUGGEST_MAX));
    values = values.slice(0, limit);
    const items = [];
    for (const value of values) {
      const el = document.createElement('div');
      try { modal.renderSuggestion(value, el); } catch (_) {}
      /*
        The escape is doubled on purpose: this whole file is a template
        literal, so a lone \\s reaches the guest as a plain 's' and the row
        that was meant to collapse whitespace quietly deleted every letter s
        in it. "the sons of the prophets" arrived as "the  on  of the prophet ".
      */
      items.push({ text: String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) });
    }
    // Replaced wholesale, so a pick can only land on the list now on screen.
    openModal.values = values;
    send('suggest-modal-results', { seq: message.seq, items });
  }

  /*
    The reader chose one. onChooseSuggestion is the plugin's own, and it runs in
    here — that is where the plugin does its work, and it reaches the vault
    through the same grants as everything else.

    The dialog closes on a pick because Obsidian's does, and the guest reports
    that rather than leaving the console to assume it: a plugin that reopened
    from inside onChooseSuggestion would otherwise have its new dialog shut by
    the console's own tidy-up.
  */
  async function pickModal(message) {
    const index = Number(message.index);
    const value = openModal.values[index];
    const modal = openModal.modal;
    openModal = null;
    // An unloaded plugin has no pane. Its observer would otherwise keep firing,
    // and a change arriving afterwards would run a handler on a plugin that is
    // no longer running — the same two reasons the dialogs are cleared here.
    closeSettingsPane();
    settingTabs.length = 0;
    // Closed before chosen, which is Obsidian's order and matters here: a
    // plugin that reopens from inside onChooseSuggestion must not then have its
    // new dialog's onClose fired by this one's tidy-up.
    try { modal.onClose(); } catch (_) {}
    /*
      WITH THE OPEN NOTE IN FRONT OF IT, AND A WORD FOR WHY NOT.

      onChooseSuggestion is where a dialog does its work, and for the plugins
      this inversion was built for that work is "write the thing they picked
      into the note". It reaches the note through getActiveViewOfType, which
      answered null until this — so a pick ran the plugin's handler, the
      handler's optional chain stopped on nothing, and the reader saw a row
      they had pressed and a note that never changed.

      A reason travels back rather than being swallowed, because every way this
      fails looks identical from the outside: the row was pressed, the dialog
      closed, nothing appeared.
    */
    let reason = null;
    if (value !== undefined) {
      /*
        Caught here rather than inside, and this is load-bearing: the console
        closes its dialog on suggest-modal-picked and on nothing else, so a
        handler that threw its way past this line would leave the reader in
        front of a dialog that no longer answers. A throw is the plugin's own
        failure and the message still goes out.
        (No backticks: this whole file is inside a template literal.)
      */
      try {
        reason = await withActiveEditor(() => modal.onChooseSuggestion(value, {}), false);
      } catch (error) {
        reason = reasonFor(error);
      }
    }
    send('suggest-modal-picked', { seq: message.seq, reopened: openModal !== null, reason });
  }

`;
