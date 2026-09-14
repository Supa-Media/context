// @ts-check

/**
 * The document that executes one reviewed plugin bundle.
 *
 * The bundle never enters this string. The trusted host sends it only after the
 * frame has loaded, which means plugin text cannot break out of an HTML or
 * script delimiter while the sandbox is being constructed. The frame has an
 * opaque origin (`sandbox="allow-scripts"`, without `allow-same-origin`) and a
 * CSP that denies every ambient network and child-execution surface. All note
 * access therefore has to cross the small postMessage protocol below.
 */
export function pluginSandboxDocument() {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; media-src 'none'; font-src 'none'; child-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">
</head><body><script>
(() => {
  'use strict';
  const VERSION = 1;
  let nonce = null;
  let instance = null;
  let counter = 0;
  const pending = new Map();
  const disposers = [];
  const commands = new Map();
  // The note the console has open, as last told by the host. Path and etag
  // only: no content crosses this boundary, and a plugin that wants the body
  // asks for it through the same audited read as any other file.
  let activeFile = null;
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
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      send('rpc', { request: { version: VERSION, requestId, operation } });
    });
  }

  class TFile {
    constructor(path, stat) {
      this.path = path;
      this.name = path.split('/').pop() || path;
      const dot = this.name.lastIndexOf('.');
      this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
      this.extension = dot > 0 ? this.name.slice(dot + 1) : '';
      this.stat = stat || { ctime: 0, mtime: 0, size: 0 };
      this.parent = null;
    }
  }

  class TFolder {
    constructor(path) {
      this.path = path;
      this.name = path.split('/').pop() || path;
      this.children = [];
      this.parent = null;
    }
  }

  function file(path, row) {
    const value = new TFile(path, row && row.stat);
    if (row && typeof row.etag === 'string') value.etag = row.etag;
    return value;
  }

  const vault = {
    async getFiles() {
      const found = [];
      const folders = [''];
      while (folders.length) {
        const prefix = folders.shift();
        const result = await request({ kind: 'vault.list', prefix });
        const rows = Array.isArray(result) ? result : (result && result.entries) || [];
        for (const row of rows) {
          if (!row || typeof row.path !== 'string') continue;
          if (row.kind === 'folder') folders.push(row.path);
          else if (row.kind === 'file') found.push(file(row.path, row));
        }
      }
      return found;
    },
    getMarkdownFiles() { return this.getFiles().then(rows => rows.filter(one => one.extension === 'md')); },
    getAbstractFileByPath(path) { return path && !path.endsWith('/') ? file(path) : new TFolder(path || ''); },
    async read(target) {
      const result = await request({ kind: 'vault.read', path: target.path });
      if (target && result && typeof result.etag === 'string') target.etag = result.etag;
      return result && typeof result.text === 'string' ? result.text : '';
    },
    cachedRead(target) { return this.read(target); },
    async create(path, text) {
      const result = await request({ kind: 'vault.create', path, text });
      return file(path, result);
    },
    async modify(target, text) {
      if (!target || typeof target.etag !== 'string') throw new Error('Context requires the current file version before a plugin may modify it');
      const result = await request({ kind: 'vault.modify', path: target.path, text, expectedEtag: target.etag });
      if (result && typeof result.etag === 'string') target.etag = result.etag;
    },
    async rename(target, to) {
      if (!target || typeof target.etag !== 'string') throw new Error('Context requires the current file version before a plugin may rename it');
      await request({ kind: 'vault.rename', from: target.path, to, expectedEtag: target.etag });
      target.path = to;
    },
    async delete(target) {
      if (!target || typeof target.etag !== 'string') throw new Error('Context requires the current file version before a plugin may delete it');
      await request({ kind: 'vault.delete', path: target.path, expectedEtag: target.etag });
    },
    on(name, callback) { return subscribe('vault:' + name, callback); },
    off(name, callback) { const set = listeners.get('vault:' + name); if (set) set.delete(callback); },
  };

  const metadataCache = {
    async getFileCache(target) { return request({ kind: 'metadata.get', path: target.path }); },
    on(name, callback) { return subscribe('metadata:' + name, callback); },
    off(name, callback) { const set = listeners.get('metadata:' + name); if (set) set.delete(callback); },
  };

  const workspace = {
    on(name, callback) { return subscribe('workspace:' + name, callback); },
    off(name, callback) { const set = listeners.get('workspace:' + name); if (set) set.delete(callback); },
    getActiveFile() { return activeFile; },
    getActiveViewOfType() { return null; },
    getLeavesOfType() { return []; },
  };

  /*
    Obsidian augments HTMLElement itself, and a plugin calls these on whatever
    it is handed: statusBarItem.setText(...), containerEl.createEl('div', ...).
    Without them an element the shim returns is one a plugin cannot write to —
    which would make addStatusBarItem reachable and useless, the exact failure
    SUPPORTED_MEMBERS was split in two to stop claiming.

    Installed only where the realm has no such member already, so a browser that
    grows one of these names keeps its own.
  */
  const elementApi = {
    setText(value) { this.textContent = value === null || value === undefined ? '' : String(value); return this; },
    appendText(value) { this.appendChild(document.createTextNode(String(value))); return this; },
    setAttr(name, value) { this.setAttribute(String(name), String(value)); return this; },
    addClass(...names) { for (const name of names) this.classList.add(String(name)); return this; },
    removeClass(...names) { for (const name of names) this.classList.remove(String(name)); return this; },
    toggleClass(names, on) {
      for (const name of Array.isArray(names) ? names : [names]) this.classList.toggle(String(name), !!on);
      return this;
    },
    empty() { while (this.firstChild) this.removeChild(this.firstChild); return this; },
    detach() { this.remove(); return this; },
    createEl(tag, options) {
      const child = document.createElement(String(tag));
      const given = options || {};
      if (given.cls) child.addClass(...(Array.isArray(given.cls) ? given.cls : String(given.cls).split(' ').filter(Boolean)));
      if (given.text !== undefined) child.textContent = String(given.text);
      if (given.attr) for (const name of Object.keys(given.attr)) child.setAttribute(name, String(given.attr[name]));
      for (const name of ['href', 'type', 'placeholder', 'title', 'value']) {
        if (given[name] !== undefined) child[name] = given[name];
      }
      this.appendChild(child);
      return child;
    },
    createDiv(options) { return this.createEl('div', options); },
    createSpan(options) { return this.createEl('span', options); },
  };
  for (const name of Object.keys(elementApi)) {
    if (typeof HTMLElement.prototype[name] === 'function') continue;
    Object.defineProperty(HTMLElement.prototype, name, {
      value: elementApi[name], writable: true, configurable: true,
    });
  }

  /*
    THE STATUS BAR: THE TEXT CROSSES, THE ELEMENT DOES NOT.

    A plugin gets a real element and writes into it however it likes. What
    reaches the console is the text that ended up in it, and the console draws
    that with its own components in its own theme — so a plugin cannot style,
    position or script anything on the trusted side, and the sandbox stays the
    only place its DOM exists.

    Reported as a whole list on every change rather than an add and a remove.
    A guest that is torn down or throws mid-render never owes the host a removal
    message it might not send, so the console's copy cannot drift from this one.
    The host's parser carries the same reasoning from its side.

    Kept out of the layout with display:none: nothing here is meant to be seen
    in the frame, which is 1x1 and invisible anyway, and a later change that
    makes a frame visible must not start drawing this by accident.
  */
  const STATUS_MAX = 8;
  const statusRoot = document.createElement('div');
  statusRoot.style.display = 'none';
  const statusIds = new WeakMap();
  let statusCount = 0;
  let statusWatch = null;
  function reportStatusBar() {
    const items = [];
    for (const el of Array.from(statusRoot.children)) {
      const id = statusIds.get(el);
      if (typeof id !== 'string') continue;
      // Collapsed and bounded here as well as on the host: a status bar item
      // is a line in a card, and a plugin that puts a paragraph in one should
      // not be able to decide how tall somebody's console is.
      const text = String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      if (text === '') continue;
      items.push({ id, text });
      if (items.length >= STATUS_MAX) break;
    }
    send('status-bar', { items });
  }

  const app = { vault, metadataCache, workspace };

  class Plugin {
    constructor() { this.app = app; this.manifest = {}; }
    addCommand(command) {
      if (!command || typeof command.id !== 'string' || typeof command.name !== 'string') return;
      commands.set(command.id, command);
      send('registration', { kind: 'command', id: command.id, name: command.name });
    }
    addRibbonIcon(icon, title, callback) {
      const id = 'ribbon-' + commands.size;
      commands.set(id, { id, name: title, callback });
      send('registration', { kind: 'ribbon', id, name: String(title || icon || 'Plugin action') });
      return document.createElement('span');
    }
    addStatusBarItem() {
      const el = document.createElement('div');
      statusCount += 1;
      statusIds.set(el, 'status-' + statusCount);
      statusRoot.appendChild(el);
      if (statusWatch === null) {
        // One observer on the container rather than one per item, because the
        // removal of an item is a mutation of the container and an observer on
        // the item itself would never see it.
        statusWatch = new MutationObserver(reportStatusBar);
        statusWatch.observe(statusRoot, { childList: true, subtree: true, characterData: true });
      }
      return el;
    }
    registerMarkdownPostProcessor() {}
    registerEditorExtension() {}
    registerEvent(ref) { if (ref && typeof ref.off === 'function') disposers.push(() => ref.off()); }
    registerDomEvent(el, type, callback, options) {
      el.addEventListener(type, callback, options);
      disposers.push(() => el.removeEventListener(type, callback, options));
    }
    registerInterval(id) { disposers.push(() => clearInterval(id)); return id; }
    addSettingTab() {}
    async loadData() {
      const result = await request({ kind: 'settings.load' });
      if (!result || typeof result.json !== 'string') return null;
      return JSON.parse(result.json);
    }
    async saveData(value) {
      const current = await request({ kind: 'settings.load' });
      await request({ kind: 'settings.save', json: JSON.stringify(value || {}), expectedEtag: current && typeof current.etag === 'string' ? current.etag : null });
    }
    register(disposer) { if (typeof disposer === 'function') disposers.push(disposer); }
  }

  class Notice {
    constructor(message) { send('notice', { message: String(message).slice(0, 500) }); }
  }

  class Component { load() {}; unload() {} }
  class MarkdownView {}
  class ItemView {}
  class PluginSettingTab { constructor(appValue, plugin) { this.app = appValue; this.plugin = plugin; } }
  class Setting { constructor() {} setName() { return this; } setDesc() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addButton() { return this; } }
  const api = {
    Plugin, Notice, Component, MarkdownView, ItemView, PluginSettingTab, Setting,
    TFile, TFolder, Vault: function Vault() {}, Workspace: function Workspace() {},
    MetadataCache: function MetadataCache() {},
    normalizePath: value => String(value).replace(/\\\\/g, '/').replace(/^\\/+|\\/+$/g, ''),
    requestUrl: options => {
      const input = typeof options === 'string' ? { url: options } : options;
      return request({ kind: 'network.request', url: input.url, method: input.method || 'GET', headers: Object.entries(input.headers || {}).map(([name, value]) => ({ name, value: String(value) })), ...(input.body === undefined ? {} : { body: String(input.body) }) });
    },
  };

  function requireModule(name) {
    if (name === 'obsidian') return api;
    throw new Error('Context sandbox does not provide module: ' + String(name));
  }

  async function unload() {
    try { if (instance && typeof instance.onunload === 'function') await instance.onunload(); } catch (_) {}
    while (disposers.length) { try { disposers.pop()(); } catch (_) {} }
    instance = null;
    commands.clear();
    listeners.clear();
    activeFile = null;
    // An unloaded plugin is inert, and a status bar that went on reporting
    // would be a line on the console from a plugin that is no longer running.
    if (statusWatch !== null) { statusWatch.disconnect(); statusWatch = null; }
    statusRoot.textContent = '';
    statusCount = 0;
  }

  const receiveHostMessage = async event => {
    const message = event.data;
    if (!message || message.source !== 'context-plugin-host' || message.version !== VERSION) return;
    // RPC replies carry no sandbox nonce. A plugin can observe every event in
    // its own realm, so including the nonce here would reveal the value the
    // trusted host uses to reject forged status and registration messages.
    if (message.type === 'rpc-result') {
      const waiting = pending.get(message.response && message.response.requestId);
      if (!waiting) return;
      pending.delete(message.response.requestId);
      if (message.response.ok) waiting.resolve(message.response.result);
      else waiting.reject(new Error(message.response.error && message.response.error.message || 'Plugin operation failed'));
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
        const run = command.callback || command.checkCallback || command.editorCallback;
        if (typeof run === 'function') await run();
        send('command-result', { id: message.id, ok: true });
      } catch (error) {
        send('command-result', { id: message.id, ok: false, error: String(error && error.message || error).slice(0, 500) });
      }
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
})();
</script></body></html>`;
}

/**
 * Whether the frame that just fired `load` is still the document we wrote.
 *
 * ## Why a count is the whole answer
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` denies the frame the
 * parent's DOM, and the CSP above denies it `fetch`, workers, child frames,
 * forms, objects and every external asset. **Not one of them stops a document
 * navigating itself.** `allow-top-navigation` governs the *top-level* browsing
 * context, not a frame's own, and the CSP directive that would have covered it
 * — `navigate-to` — was removed from the specification and ships in no engine.
 * So the frame can stop being ours, and the host cannot ask it politely
 * whether it still is: reading `contentWindow.location` across an opaque
 * origin throws, and any answer the frame itself gave would be the untrusted
 * party vouching for itself.
 *
 * What the host *can* see is the `load` event, and that is exact rather than a
 * heuristic. `srcdoc` is written once, from a `useMemo` constant, and is never
 * re-set for the life of the element — so the first load is the document we
 * wrote and any later one is a document somebody else chose.
 *
 * A frame that is no longer ours must be handed nothing further: not the
 * sandbox nonce, not the bundle, and no answer to an `rpc` it sends. After a
 * navigation `event.source` still equals `frame.contentWindow`, so identity
 * alone stops distinguishing the successor from the original — this count is
 * what the host has instead.
 *
 * Native needs no equivalent because it refuses the navigation outright
 * (`originWhitelist` plus `onShouldStartLoadWithRequest`); a WebView can be
 * told what it may load, an iframe cannot.
 *
 * @param {number} loadCount How many `load` events this element has fired.
 */
export function sandboxFrameIsOurs(loadCount) {
  return loadCount === 1;
}

/**
 * How many status bar items one plugin may put on its card.
 *
 * Obsidian imposes no limit and neither does the shim's own list — this is the
 * console's, because the items are drawn in a card beside the Stop button and a
 * plugin that added forty of them would push it off the screen. Enforced on
 * both sides: the guest stops reporting past this, and the host truncates
 * anything that arrives anyway, because the guest is the untrusted half and a
 * cap it applies to itself is not a cap.
 */
export const STATUS_BAR_MAX = 8;

/**
 * Strictly recognize messages that may cross from the untrusted frame.
 * @param {unknown} value
 * @param {string} expectedNonce
 */
export function parsePluginSandboxMessage(value, expectedNonce) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = /** @type {Record<string, unknown>} */ (value);
  if (row.source !== "context-plugin-sandbox" || row.version !== 1) return null;
  if (row.type === "ready") return { type: "ready" };
  if (row.nonce !== expectedNonce) return null;
  switch (row.type) {
    case "loaded":
    case "unloaded":
      return { type: row.type };
    case "rpc":
      return row.request && typeof row.request === "object"
        ? { type: "rpc", request: row.request }
        : null;
    case "crashed":
      return typeof row.code === "string" && typeof row.message === "string"
        ? {
            type: "crashed",
            code: row.code.slice(0, 80),
            message: row.message.slice(0, 500),
          }
        : null;
    case "notice":
      return typeof row.message === "string"
        ? { type: "notice", message: row.message.slice(0, 500) }
        : null;
    /*
      The guest's answer to a host `command`.

      Nonce-checked above with everything else observable, and for the same
      reason: a forged result would report a command as run that never was, or
      report success for one that threw. `ok` is required to be a boolean
      rather than coerced — a message that simply omits it is malformed, and
      treating a missing field as failure would invent an outcome the guest
      never claimed.
    */
    case "command-result":
      return typeof row.id === "string" && typeof row.ok === "boolean"
        ? {
            type: "command-result",
            id: row.id.slice(0, 100),
            ok: row.ok,
            error: typeof row.error === "string" ? row.error.slice(0, 500) : null,
          }
        : null;
    /*
      Everything the plugin currently has in its status bar.

      **A whole list every time, not an add and a remove.** The alternative
      needs the guest to report a removal, and a guest that is torn down, throws
      mid-render, or simply forgets leaves a line on the console describing an
      item that no longer exists — the same stale-claim failure the
      registrations card was careful to avoid, one layer down. Replacing the
      list makes the console's copy unable to drift from the guest's.

      Truncated rather than refused, unlike a malformed entry. Nine items is a
      plugin being greedy and the eight before it are real; an entry without a
      string `text` is not something the shim can produce, so the message is
      dropped whole.
    */
    case "status-bar": {
      if (!Array.isArray(row.items)) return null;
      const items = [];
      for (const entry of row.items) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const one = /** @type {Record<string, unknown>} */ (entry);
        if (typeof one.id !== "string" || typeof one.text !== "string") return null;
        if (items.length >= STATUS_BAR_MAX) continue;
        items.push({ id: one.id.slice(0, 60), text: one.text.slice(0, 120) });
      }
      return { type: "status-bar", items };
    }
    case "registration":
      return (row.kind === "command" || row.kind === "ribbon") &&
        typeof row.id === "string" &&
        typeof row.name === "string"
        ? {
            type: "registration",
            kind: row.kind,
            id: row.id.slice(0, 100),
            name: row.name.slice(0, 200),
          }
        : null;
    default:
      return null;
  }
}
