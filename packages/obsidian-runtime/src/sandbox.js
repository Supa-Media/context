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
    on() { return { off() {} }; },
    off() {},
  };

  const metadataCache = {
    async getFileCache(target) { return request({ kind: 'metadata.get', path: target.path }); },
    on() { return { off() {} }; },
    off() {},
  };

  const workspace = {
    on() { return { off() {} }; },
    off() {},
    getActiveFile() { return null; },
    getActiveViewOfType() { return null; },
    getLeavesOfType() { return []; },
  };

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
