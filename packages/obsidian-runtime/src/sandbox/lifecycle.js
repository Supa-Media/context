// @ts-check
/**
 * Plugin bundle load/unload and the host-to-guest message dispatcher.
 *
 * Moved verbatim out of `pluginSandboxDocument()` in ../sandbox.js; this is
 * source text for the sandboxed document, not code that runs in this realm.
 */
export const LIFECYCLE_JS = `  async function unload() {
    try { if (instance && typeof instance.onunload === 'function') await instance.onunload(); } catch (_) {}
    while (disposers.length) { try { disposers.pop()(); } catch (_) {} }
    instance = null;
    commands.clear();
    listeners.clear();
    activeFile = null;
    /*
      And the editor over it. An unloaded plugin holding a view would be one
      whose writes land on a note nobody asked it to touch, through a session
      the console has already torn down.
    */
    activeEditor = null;
    viewAsked = false;
    // An unloaded plugin is inert, and a status bar that went on reporting
    // would be a line on the console from a plugin that is no longer running.
    suggesters.length = 0;
    offered = null;
    processors.length = 0;
    /*
      An unloaded plugin's dialogs are not answerable. openModal mattered
      already — a pick would have run onChooseSuggestion on a plugin that is no
      longer running — and openTextModal holds a live MutationObserver besides,
      which would go on firing against a document nobody sees.
      (No backticks: this whole file is inside a template literal.)
    */
    openModal = null;
    if (openTextModal !== null) { openTextModal.__contextUnwatch(); openTextModal = null; }
    if (statusWatch !== null) { statusWatch.disconnect(); statusWatch = null; }
    statusRoot.textContent = '';
    statusCount = 0;
    statusSent = null;
  }

  const receiveHostMessage = async event => {
    const message = event.data;
    if (!message || message.source !== 'context-plugin-host' || message.version !== VERSION) return;
    /*
      THE ONLY PART OF A HOST MESSAGE ITS SENDER CANNOT WRITE.

      The 'context-plugin-host' marker above is a string in the payload, so any
      window holding a handle to this frame can write it: opener.frames[i] then
      postMessage reaches a nested frame across origins by design, and an opaque
      origin does not change that. What such a sender cannot forge is
      event.source, which the user agent sets to the posting window.

      That matters because the claim below -- that a host-to-guest message can
      only ask the plugin to act inside its own realm -- stopped being true once
      the command path grew a read and a write of its own. A command now makes
      this guest issue vault.read against the open note and vault.modify back
      onto it, so a forged one is an unauthorized write to a customer's note,
      timed by whoever forged it.

      Nonce-ing this direction is still refused, for the reason given below: the
      plugin shares this realm and would read the nonce out of the event.

      event.source is absent on the React Native path, where the host injects
      into the document rather than posting between windows, so an absent source
      is accepted and a foreign one is refused. In a WebView window.parent is
      window, which is what an injected post carries anyway.
    */
    if (event.source && event.source !== window.parent) return;
    // RPC replies carry no sandbox nonce. A plugin can observe every event in
    // its own realm, so including the nonce here would reveal the value the
    // trusted host uses to reject forged status and registration messages.
    if (message.type === 'rpc-result') {
      const waiting = pending.get(message.response && message.response.requestId);
      if (!waiting) return;
      pending.delete(message.response.requestId);
      if (message.response.ok) waiting.resolve(message.response.result);
      else {
        const failed = message.response.error;
        const error = new Error(failed && failed.message || 'Plugin operation failed');
        /*
          The code, kept rather than flattened into the sentence. A refusal the
          owner can lift — CAPABILITY_DENIED — and a plugin that broke are
          different things to say to a reader, and the message alone cannot
          tell them apart. Plugins see this too, as Obsidian's own errors carry
          fields; it grants nothing they did not already have.
        */
        if (failed && typeof failed.code === 'string') error.code = failed.code;
        waiting.reject(error);
      }
      return;
    }
    if (nonce === null) {
      if (message.type !== 'load' || typeof message.nonce !== 'string') return;
      nonce = message.nonce;
    }
    // Once loaded, host-to-guest messages omit the nonce. They can only ask the
    // plugin to act inside its own realm, so accepting a forged one grants no
    // authority; keeping the nonce off observable events preserves the trust
    // boundary for guest-to-host health and registration messages.
    if (message.type === 'command') {
      const command = commands.get(message.id);
      if (!command) return;
      try {
        let reason = null;
        if (typeof command.editorCallback === 'function') {
          await withActiveEditor(
            editor => command.editorCallback(editor, activeEditor === null ? null : activeEditor.view),
            true,
          );
        } else {
          const run = command.callback || command.checkCallback;
          /*
            A plain callback runs with the open note in front of it too, which
            is not a widening of what a command may do: Obsidian gives every
            command the same reach through getActiveViewOfType, and a write
            still goes through the same audited RPC under the same grant. What
            it changes is that a plugin which asks for the editor now gets one.

            A reason from here is reported rather than thrown. The plugin did
            not fail — it asked for something Context could not give it — so
            what travels is the word for that, and the console writes the
            sentence.
          */
          if (typeof run === 'function') reason = await withActiveEditor(() => run(), false);
        }
        send('command-result', { id: message.id, ok: reason === null, reason });
      } catch (error) {
        send('command-result', { id: message.id, ok: false, error: String(error && error.message || error).slice(0, 500) });
      }
      return;
    }
    // A suggestion is only ever offered by a running plugin, and only over the
    // line the host handed in. An unloaded guest answers nothing at all rather
    // than an empty list, so the host can tell "no plugin" from "no match".
    if (message.type === 'suggest-query') {
      if (instance === null) return;
      await answerSuggest(message);
      return;
    }
    if (message.type === 'suggest-apply') {
      if (instance === null) return;
      await applySuggest(message);
      return;
    }
    // The dialog's two halves. Answered only while a plugin has one open: a
    // guest with no open modal says nothing, so the console can tell "closed"
    // from "no matches" — the same distinction the editor's suggester keeps.
    if (message.type === 'suggest-modal-query') {
      if (instance === null || openModal === null) return;
      await answerModal(message);
      return;
    }
    if (message.type === 'suggest-modal-pick') {
      if (instance === null || openModal === null) return;
      await pickModal(message);
      return;
    }
    if (message.type === 'suggest-modal-dismiss') {
      if (instance === null || openModal === null) return;
      // The reader closed it, so the plugin's own onClose runs and the guest
      // forgets the values. Not routed through close(), which would send the
      // console a message about a dialog the console just shut.
      const modal = openModal.modal;
      openModal = null;
      try { modal.onClose(); } catch (_) {}
      return;
    }
    if (message.type === 'settings-pane-open') {
      if (instance === null) return;
      await openSettingsPane();
      return;
    }
    if (message.type === 'settings-pane-change') {
      if (instance === null) return;
      if (typeof message.index !== 'number') return;
      await changeSettingsPane(message);
      return;
    }
    if (message.type === 'settings-pane-close') {
      closeSettingsPane();
      return;
    }
    if (message.type === 'text-modal-dismiss') {
      if (instance === null || openTextModal === null) return;
      // The reader closed it. Same shape as the suggestion dialog's dismissal:
      // the plugin's onClose runs and the observer stops, and it does not go
      // through close(), which would send the console a message about a dialog
      // the console has already shut.
      const modal = openTextModal;
      openTextModal = null;
      modal.__contextUnwatch();
      try { modal.onClose(); } catch (_) {}
      return;
    }
    // A preview carries the note's own links into the sandbox, so like a
    // suggestion it is the host that decides whether this plugin may be asked,
    // and an unloaded guest answers nothing at all rather than an empty list.
    if (message.type === 'preview-query') {
      if (instance === null) return;
      await answerPreview(message);
      return;
    }
    // An unloaded plugin is inert, and that has to include the state it is
    // handed: a guest that went on tracking the open note after unload would
    // hold a file the reader has closed, and hand it to whatever loaded next.
    if ((message.type === 'active-file' || message.type === 'vault-event') && instance === null) return;
    if (message.type === 'active-file') {
      // null is a real value here: nothing is open, and a plugin asking then
      // must get null rather than the last note somebody looked at.
      if (typeof message.path === 'string' && message.path !== '') {
        activeFile = file(message.path, typeof message.etag === 'string' ? { etag: message.etag } : null);
      } else {
        activeFile = null;
      }
      emit('workspace:file-open', activeFile);
      return;
    }
    if (message.type === 'vault-event') {
      // Only what Context itself changed — see the host. A rename carries both
      // paths because Obsidian's own handler signature takes the old one.
      const target = typeof message.path === 'string'
        ? file(message.path, typeof message.etag === 'string' ? { etag: message.etag } : null)
        : null;
      if (target === null) return;
      if (message.kind === 'rename') emit('vault:rename', target, String(message.from || ''));
      else if (message.kind === 'create') emit('vault:create', target);
      else if (message.kind === 'delete') emit('vault:delete', target);
      else if (message.kind === 'modify') emit('vault:modify', target);
      else return;
      if (message.kind !== 'delete') emit('metadata:changed', target);
      return;
    }
    if (message.type === 'unload') {
      await unload();
      send('unloaded');
      return;
    }
    if (message.nonce !== nonce) return;
    if (message.type !== 'load' || typeof message.mainJs !== 'string') return;
    try {
      const module = { exports: {} };
      const script = document.createElement('script');
      script.textContent = '(function(module,exports,require){\\n' + message.mainJs + '\\n})(window.__contextModule,window.__contextModule.exports,window.__contextRequire);';
      window.__contextModule = module;
      window.__contextRequire = requireModule;
      document.head.appendChild(script);
      script.remove();
      delete window.__contextModule;
      delete window.__contextRequire;
      const Exported = module.exports && (module.exports.default || module.exports);
      if (typeof Exported !== 'function') throw new Error('Plugin bundle did not export a plugin class');
      instance = new Exported(app, JSON.parse(message.manifestJson || '{}'));
      instance.app = app;
      instance.manifest = JSON.parse(message.manifestJson || '{}');
      if (typeof instance.onload === 'function') await instance.onload();
      send('loaded');
    } catch (error) {
      send('crashed', { code: 'PLUGIN_LOAD_FAILED', message: String(error && error.message || error).slice(0, 500) });
    }
  };
  // react-native-webview delivers host messages on window on iOS and on
  // document on Android. A browser delivers on window only.
  window.addEventListener('message', receiveHostMessage);
  document.addEventListener('message', receiveHostMessage);

  post({ source: 'context-plugin-sandbox', version: VERSION, type: 'ready' });
`;
