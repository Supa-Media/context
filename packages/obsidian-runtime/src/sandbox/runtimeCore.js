// @ts-check
/**
 * The RPC/event core: postMessage plumbing, request/response bookkeeping and the vault/metadata/workspace event bus.
 *
 * Moved verbatim out of `pluginSandboxDocument()` in ../sandbox.js; this is
 * source text for the sandboxed document, not code that runs in this realm.
 */
export const RUNTIME_CORE_JS = `  'use strict';
  const VERSION = 1;
  let nonce = null;
  let instance = null;
  let counter = 0;
  const pending = new Map();
  let inFlightRequests = 0;
  const requestIdleWaiters = [];
  const disposers = [];
  const commands = new Map();
  // The note the console has open, as last told by the host. Path and etag
  // only: no content crosses this boundary, and a plugin that wants the body
  // asks for it through the same audited read as any other file.
  let activeFile = null;
  /*
    THE OPEN NOTE AS AN EDITOR, WHILE CONTEXT IS RUNNING SOMETHING FOR THE PLUGIN.

    getActiveViewOfType is how an Obsidian plugin reaches the note somebody is
    looking at, and it is the ending of nearly every "insert this" flow there
    is. It answered null here, for ever, which made a whole class of plugin
    silently inert: Bible Reference's verse lookup ends in

        this.app.workspace.getActiveViewOfType(MarkdownView)?.editor
          .replaceRange(verse, editor.getCursor())

    and an optional chain on null is a pick that does nothing, reports nothing
    and looks exactly like a dialog whose rows cannot be pressed.

    So a view exists while — and only while — Context is running a piece of work
    the plugin was asked for: a command, a ribbon press, or a choice made in a
    dialog it opened. withActiveEditor reads the note before that work and
    writes it back after, through the audited RPC the editorCallback path
    already used. Outside that window this is null, because there is nothing to
    write back into and an editor a plugin could keep would be an editor whose
    edits go nowhere.
  */
  let activeEditor = null;
  /*
    Whether the plugin reached for that view during the current piece of work.

    The difference between "it had nowhere to write" and "it never wanted to
    write", which is the difference between a failure worth putting in front of
    a reader and silence. A translation-switch dialog touches no note and must
    not make the console say a note was needed.
  */
  let viewAsked = false;
  // name -> Set(callback). One registry for vault, metadata and workspace
  // events, keyed by the name Obsidian uses, so on() can return a real
  // reference with a working off() instead of the dead handle it used to.
  const listeners = new Map();
  function subscribe(name, callback) {
    if (typeof callback !== 'function') return { off() {} };
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    return { off() { const set = listeners.get(name); if (set) set.delete(callback); } };
  }
  function emit(name, ...args) {
    const set = listeners.get(name);
    if (!set) return;
    // A copy, because a handler that calls off() during dispatch would
    // otherwise mutate the set being iterated.
    for (const callback of [...set]) {
      try { callback(...args); } catch (_) {}
    }
  }
  const post = payload => {
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    } else {
      window.parent.postMessage(payload, '*');
    }
  };

  function send(type, fields) {
    if (nonce === null) return;
    post(Object.assign({ source: 'context-plugin-sandbox', version: VERSION, nonce, type }, fields || {}));
  }

  function request(operation) {
    const requestId = 'p_' + Date.now().toString(36) + '_' + (++counter).toString(36);
    inFlightRequests += 1;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      send('rpc', { request: { version: VERSION, requestId, operation } });
    }).finally(() => {
      inFlightRequests -= 1;
      if (inFlightRequests !== 0) return;
      while (requestIdleWaiters.length) requestIdleWaiters.shift()();
    });
  }

  function requestsIdle() {
    return inFlightRequests === 0
      ? Promise.resolve()
      : new Promise(resolve => requestIdleWaiters.push(resolve));
  }

`;
