/**
 * A tiny Dropbox over in-memory maps, one per access token.
 *
 * Enough of `files/download`, `files/upload`, `files/delete_v2` and
 * `files/list_folder` for the real `DropboxStore` to drive a workspace end to
 * end. Two properties are modelled deliberately, because they are the two that
 * a Dropbox-shaped tenancy bug would hide behind:
 *
 *  - **The access token selects the account, and nothing else does.** There is
 *    no bucket name, no endpoint, and no per-tenant host: two Dropbox tenants
 *    reach the same two URLs, and the only thing between them is the bearer
 *    token the binding carried. An unknown token is a 401, exactly as Dropbox
 *    answers one.
 *  - **A missing path is a 409 with a tagged body, never a 404**, and a lost
 *    conditional write is a 409 tagged `conflict`. A stub that answered 404
 *    would let an adapter reading the status instead of the tag pass.
 */
export function dropboxTaggedError(summary, status = 409) {
  const segments = summary
    .split("/")
    .filter((part) => part && part !== "..." && part !== ".");
  let error = null;
  for (const segment of [...segments].reverse()) {
    error = error ? { ".tag": segment, [segment]: error } : { ".tag": segment };
  }
  // `UploadError.path` is the one variant that is NOT a plain nested union.
  // It carries `UploadWriteFailed`, a *struct* (`reason WriteError`,
  // `upload_session_id String`), and Stone flattens struct-valued variants —
  // so Dropbox sends `{".tag":"path", reason:{…}, upload_session_id:"…"}`
  // rather than nesting under `path`. Deriving the nested form everywhere
  // replaced one shape Dropbox does not send with another, at the one
  // endpoint where it matters most: the conditional-write conflict.
  if (segments[0] === "path" && segments[1] === "conflict" && error?.path) {
    error = {
      ".tag": "path",
      reason: error.path,
      upload_session_id: "FAKE-upload-session",
    };
  }
  return new Response(JSON.stringify({ error_summary: summary, error: error ?? {} }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createDropboxBackend() {
  const API_ORIGIN = "https://api.dropboxapi.com";
  const CONTENT_ORIGIN = "https://content.dropboxapi.com";

  /** access token → Map(dropbox path → { body, rev }) */
  const accounts = new Map();
  /**
   * access token → Set(dropbox folder path)
   *
   * **This is the thing the fake used to get wrong**, and it is the difference
   * between Dropbox and every other backend here. Folders were synthesised
   * from the keys, exactly as `S3Store` has to synthesise them — so an emptied
   * directory vanished from the fake and stayed in the product. A folder move
   * on Dropbox left its source folder behind, went on listing it, and read as
   * a copy; the suite could not see it because the fake was an S3 wearing
   * Dropbox's URLs.
   *
   * Real directories, created by an upload and removed only by a delete aimed
   * at them, are what make that reproducible.
   */
  const directories = new Map();
  let revCounter = 0;

  /** Register an account and return its file map, so a test can seed it. */
  function accountFor(accessToken) {
    if (!accounts.has(accessToken)) accounts.set(accessToken, new Map());
    if (!directories.has(accessToken)) directories.set(accessToken, new Set());
    for (const key of accounts.get(accessToken).keys()) noteAncestors(accessToken, key);
    return accounts.get(accessToken);
  }

  /** Folders a path implies, the way an upload creates them on Dropbox. */
  function noteAncestors(token, path) {
    const held = directories.get(token);
    if (!held) return;
    const parts = path.replace(/^\//, "").split("/").slice(0, -1);
    for (let end = 1; end <= parts.length; end += 1) {
      held.add(`/${parts.slice(0, end).join("/")}`);
    }
  }

  /** Every folder registered for an account, so a test can assert on them. */
  function foldersFor(accessToken) {
    if (!directories.has(accessToken)) directories.set(accessToken, new Set());
    for (const key of accounts.get(accessToken)?.keys() || []) noteAncestors(accessToken, key);
    return directories.get(accessToken);
  }

  /**
   * A Dropbox error, with the tags Dropbox actually sends.
   *
   * `error` used to be `{}` — an error object with no tag in it, which is not
   * a shape Dropbox produces. It passed only because the adapter searched the
   * raw body for a substring, so the summary line alone was enough. A fake
   * built to the check rather than to the API stops being evidence the moment
   * the check changes, and it hid a real defect: an adapter reading tags
   * correctly saw *no* tag here and treated a missing file as a hard failure.
   *
   * The union is nested the way Dropbox nests it — `path/not_found` becomes
   * `{".tag":"path", path:{".tag":"not_found"}}` — so the summary and the tags
   * cannot drift apart.
   */
  const tagged = dropboxTaggedError;

  const notFound = () => tagged("path/not_found/...");
  const conflict = () => tagged("path/conflict/file/...");

  function json(body) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function decodeBody(body) {
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return new TextDecoder().decode(body);
    return new TextDecoder().decode(new Uint8Array(body));
  }

  async function handle(url, init = {}) {
    const path = new URL(url).pathname;
    const headers = init.headers || {};
    const token = String(headers.Authorization || "").replace(/^Bearer /, "");
    // Dropbox's own answer to a token it does not know. It is *not* a 409, so
    // an adapter that read absence off a status alone would surface an expired
    // token as an empty context.
    if (!accounts.has(token)) return tagged("invalid_access_token/", 401);
    const files = accounts.get(token);
    const arg = headers["Dropbox-API-Arg"] ? JSON.parse(headers["Dropbox-API-Arg"]) : null;
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;

    if (path === "/2/files/download") {
      const file = files.get(arg.path);
      if (!file) return notFound();
      return new Response(file.body, {
        status: 200,
        headers: { "Dropbox-API-Result": JSON.stringify({ rev: file.rev, size: file.body.length }) },
      });
    }

    // Dropbox answers "is this file there" with `get_metadata`, never with a
    // folder listing, and the adapter now asks it that way. A fake that knew
    // only `list_folder` would make the existence check look unavailable on
    // this backend — which is the shape of the real bug it was added for.
    if (path === "/2/files/get_metadata") {
      const file = files.get(body.path);
      if (!file) return notFound();
      return json({ ".tag": "file", rev: file.rev, path_display: body.path, size: file.body.length });
    }

    if (path === "/2/files/upload") {
      const current = files.get(arg.path);
      if (arg.mode?.[".tag"] === "update" && current?.rev !== arg.mode.update) return conflict();
      const rev = `r${++revCounter}`;
      files.set(arg.path, { body: decodeBody(init.body), rev });
      // An upload creates the folders above it, and they outlive the file.
      noteAncestors(token, arg.path);
      return json({ rev, path_display: arg.path, size: files.get(arg.path).body.length });
    }

    if (path === "/2/files/delete_v2") {
      const held = directories.get(token) || new Set();
      if (files.delete(body.path)) return json({ metadata: { path_display: body.path } });
      // Dropbox deletes a folder recursively, which is why the adapter has to
      // establish emptiness before it asks.
      if (held.has(body.path)) {
        held.delete(body.path);
        for (const key of [...files.keys()]) {
          if (key.startsWith(`${body.path}/`)) files.delete(key);
        }
        for (const folder of [...held]) {
          if (folder.startsWith(`${body.path}/`)) held.delete(folder);
        }
        return json({ metadata: { path_display: body.path } });
      }
      return notFound();
    }

    if (path === "/2/files/list_folder") {
      const held = directories.get(token) || new Set();
      const root = body.path === "" ? "/" : `${body.path}/`;
      const children = [...files.keys()].filter((key) => key.startsWith(root)).sort();
      if (body.path !== "" && children.length === 0 && !held.has(body.path)) return notFound();
      const entries = [];
      const folders = new Set();
      for (const key of children) {
        const remainder = key.slice(root.length);
        const slash = remainder.indexOf("/");
        if (slash === -1) {
          entries.push({
            ".tag": "file",
            path_display: key,
            size: files.get(key).body.length,
            server_modified: "2026-08-01T10:00:00Z",
          });
          continue;
        }
        folders.add(root + remainder.slice(0, slash));
        if (body.recursive) {
          entries.push({
            ".tag": "file",
            path_display: key,
            size: files.get(key).body.length,
            server_modified: "2026-08-01T10:00:00Z",
          });
        }
      }
      /*
        Directories that exist in their own right, including the empty ones.
        An S3 cannot produce this entry and Dropbox does, which is the whole
        reason this fake keeps a folder set rather than deriving one.
      */
      for (const folder of held) {
        if (!folder.startsWith(root) || folder === body.path) continue;
        if (!body.recursive && folder.slice(root.length).includes("/")) continue;
        folders.add(folder);
      }
      for (const folder of folders) entries.push({ ".tag": "folder", path_display: folder });
      return json({ entries, has_more: false, cursor: "" });
    }

    return new Response(JSON.stringify({ error_summary: "unsupported/" }), { status: 400 });
  }

  function install() {
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(API_ORIGIN) || url.startsWith(CONTENT_ORIGIN)) return handle(url, init);
      return previous ? previous(input, init) : new Response("", { status: 404 });
    };
    return () => {
      globalThis.fetch = previous;
    };
  }

  return { accounts, accountFor, foldersFor, handle, install };
}
