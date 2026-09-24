// @ts-check
/**
 * The brokered network surface: fetch and requestUrl routed through the host's egress broker, plus the CodeMirror compat shims.
 *
 * Moved verbatim out of `pluginSandboxDocument()` in ../sandbox.js; this is
 * source text for the sandboxed document, not code that runs in this realm.
 */
export const NETWORK_JS = `  function decodeBase64(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  /**
   * A plugin's own fetch, routed through the same broker requestUrl uses.
   *
   * ## Why this exists
   *
   * The sandbox CSP is connect-src 'none', so a direct fetch from in here is
   * refused by the browser before it leaves. That is deliberate and stays: the
   * frame must never reach the network on its own, or the host stops being the
   * one that decides which hosts a plugin may talk to.
   *
   * What was wrong was that ONLY requestUrl was brokered. Obsidian offers both,
   * plugins use both, and a plugin using plain fetch got a TypeError with no
   * explanation — measured on the real Bible Reference release, which fetches
   * its verses that way. Its network call was refused, its own error handler
   * swallowed the failure, and it served bundled fallback text labelled with
   * the translation the reader had asked for and had not got. A grant the owner
   * had approved, a capability the card said it had, and nothing worked.
   *
   * ## The boundary is unchanged
   *
   * Every request still goes to the host as a network.request RPC, still
   * carries the plugin's runtime token, and is still refused there unless the
   * grant names the host. This widens what a plugin can CALL, never what it can
   * reach: brokerNetworkRequest is the gate, and it has not moved.
   *
   * ## What it answers with
   *
   * A real Response, so res.ok, res.status, res.json() and res.text() behave.
   * A refusal rejects with a TypeError, which is what fetch does on a network
   * failure — a plugin's own catch then runs the path it already has for being
   * offline, rather than an unfamiliar error shape it will not handle.
   */
  async function brokeredFetch(input, init) {
    const options = init || {};
    const fromRequest = input && typeof input === 'object' && typeof input.url === 'string' ? input : null;
    const url = fromRequest ? fromRequest.url : String(input);
    const method = String(options.method || (fromRequest && fromRequest.method) || 'GET').toUpperCase();
    const headers = [];
    const given = options.headers || (fromRequest && fromRequest.headers) || null;
    if (given) {
      // Headers, a plain object, or an array of pairs — fetch takes all three,
      // and a plugin will use whichever its author reached for.
      if (typeof given.forEach === 'function' && typeof given.append === 'function') {
        given.forEach((value, name) => headers.push({ name: String(name), value: String(value) }));
      } else if (Array.isArray(given)) {
        for (const pair of given) {
          if (Array.isArray(pair) && pair.length >= 2) headers.push({ name: String(pair[0]), value: String(pair[1]) });
        }
      } else {
        for (const name of Object.keys(given)) headers.push({ name, value: String(given[name]) });
      }
    }
    let result;
    try {
      result = await request({
        kind: 'network.request',
        url,
        method,
        headers,
        ...(options.body === undefined || options.body === null ? {} : { body: String(options.body) }),
      });
    } catch (error) {
      /*
        fetch rejects with a TypeError when a request cannot be made, so a
        refusal has to look like one. The host's own sentence is kept as the
        message: a plugin that logs it gives the reader something to act on,
        and "Failed to fetch" gives them nothing.
      */
      throw new TypeError(String((error && error.message) || 'Failed to fetch'));
    }
    const bytes = decodeBase64(result && result.bodyBase64);
    const responseHeaders = new Headers();
    for (const row of result && Array.isArray(result.headers) ? result.headers : []) {
      if (row && typeof row.name === 'string' && typeof row.value === 'string') {
        try { responseHeaders.set(row.name, row.value); } catch (_) {}
      }
    }
    const status = result && Number.isInteger(result.status) ? result.status : 0;
    /*
      A Response cannot be constructed with status 0, and 204/205/304 cannot
      carry a body. Both are real answers from a broker, so they are mapped
      rather than thrown: status 0 means the host answered with nothing usable,
      which is a failure in fetch's terms.
    */
    if (status === 0) throw new TypeError('Failed to fetch');
    const body = status === 204 || status === 205 || status === 304 ? null : bytes;
    return new Response(body, { status, headers: responseHeaders });
  }

  function requestUrlResponse(result) {
    const bytes = decodeBase64(result && result.bodyBase64);
    const text = new TextDecoder().decode(bytes);
    const headers = {};
    for (const row of result && Array.isArray(result.headers) ? result.headers : []) {
      if (row && typeof row.name === 'string' && typeof row.value === 'string') {
        headers[row.name.toLowerCase()] = row.value;
      }
    }
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return {
      status: result && Number.isInteger(result.status) ? result.status : 0,
      headers,
      arrayBuffer: bytes.buffer,
      json,
      text,
    };
  }

  /*
    YouVersion 1.8.1 imports these three modules while constructing an editor
    extension, before onload can register it. Context does not mount third-party
    extensions in the trusted editor yet, so these are deliberately inert
    compatibility objects inside the opaque guest, not the host's CodeMirror
    instances. They let the reviewed bundle load without pretending editor
    decorations or suggestions are implemented.
  */
  class CompatRangeSetBuilder {
    add() {}
    finish() { return []; }
  }
  class CompatWidgetType {}
  const codeMirrorModules = {
    '@codemirror/language': {
      syntaxTree() { return { iterate() {} }; },
    },
    '@codemirror/state': { RangeSetBuilder: CompatRangeSetBuilder },
    '@codemirror/view': {
      Decoration: { replace(spec) { return { spec }; } },
      ViewPlugin: { fromClass(extensionClass, spec) { return { extensionClass, spec }; } },
      WidgetType: CompatWidgetType,
    },
  };

  const api = {
    Plugin, Notice, Component, Events, Modal, MarkdownView, ItemView, EditorSuggest, SuggestModal,
    FuzzySuggestModal, PluginSettingTab, Setting,
    TFile, TFolder, Vault: function Vault() {}, Workspace: function Workspace() {},
    MetadataCache: function MetadataCache() {},
    normalizePath: value => String(value).replace(/\\\\/g, '/').replace(/^\\/+|\\/+$/g, ''),
    requestUrl: async options => {
      const input = typeof options === 'string' ? { url: options } : options;
      const result = await request({ kind: 'network.request', url: input.url, method: input.method || 'GET', headers: Object.entries(input.headers || {}).map(([name, value]) => ({ name, value: String(value) })), ...(input.body === undefined ? {} : { body: String(input.body) }) });
      return requestUrlResponse(result);
    },
  };

  /*
    Installed over the frame's own fetch rather than offered as a new name,
    because the code that needs it is somebody else's and already written. A
    plugin calls fetch; it does not call contextFetch.

    XMLHttpRequest is deliberately NOT shimmed. It is synchronous-capable and
    its surface is large, so a half-built one is the "present and inert" trap
    this package keeps having to undo — a plugin would get an object that looks
    like XHR and never fires. Absent, it throws where it stands and the scanner
    reports it, which is the honest failure.
  */
  try {
    Object.defineProperty(window, 'fetch', {
      value: brokeredFetch, writable: true, configurable: true,
    });
  } catch (_) {}

  function requireModule(name) {
    if (name === 'obsidian') return api;
    if (Object.prototype.hasOwnProperty.call(codeMirrorModules, name)) return codeMirrorModules[name];
    throw new Error('Context sandbox does not provide module: ' + String(name));
  }

`;
