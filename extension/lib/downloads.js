globalThis.browserMcpDownloads = (() => {
  const STORAGE_KEY = "browserMcpDownloadRecords";
  const RECORDS_LIMIT = 100;
  const SENSITIVE_QUERY_KEY =
    /^(access[_-]?token|assertion|auth|authorization|client[_-]?secret|code|credential|id[_-]?token|jwt|key|oauth[_-]?token|password|passwd|refresh[_-]?token|secret|session(?:[_-]?(?:id|token))?|sig|signature|state|token|x-amz-(?:credential|security-token|signature))$/i;
  const records = new Map();
  const pendingStarts = new Map();
  let writeQueue = Promise.resolve();
  const loaded = initialize();

  function randomId() {
    return globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  async function initialize() {
    const stored = await chrome.storage.session.get({ [STORAGE_KEY]: [] });
    const values = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
    for (const value of values) {
      if (!value || typeof value !== "object" || typeof value.downloadId !== "string") continue;
      records.set(value.downloadId, { ...value });
    }
    prune();
  }

  function ready() {
    return loaded;
  }

  function prune() {
    if (records.size <= RECORDS_LIMIT) return;
    const terminal = [...records.values()]
      .filter((record) => record.terminalAt)
      .sort((left, right) => left.terminalAt - right.terminalAt);
    while (records.size > RECORDS_LIMIT && terminal.length) records.delete(terminal.shift().downloadId);
  }

  function persist() {
    prune();
    const values = [...records.values()].slice(-RECORDS_LIMIT);
    writeQueue = writeQueue
      .catch(() => {})
      .then(() => chrome.storage.session.set({ [STORAGE_KEY]: values }));
    return writeQueue;
  }

  function cleanLeaf(value, fallback = "download") {
    let name = String(value || "").trim();
    try {
      name = decodeURIComponent(name);
    } catch {
      name = String(value || "").trim();
    }
    name = name.split(/[\\/]/).pop() || fallback;
    name = name
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/[<>:"|?*]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim();
    if (!name || name === "." || name === "..") return fallback;
    while (BufferBytes(name) > 180) name = name.slice(0, -1);
    return name || fallback;
  }

  function BufferBytes(value) {
    return new TextEncoder().encode(value).length;
  }

  function validateUrl(value) {
    let parsed;
    try {
      parsed = new URL(String(value || ""));
    } catch {
      throw new Error("download url must be an absolute HTTP or HTTPS URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("download url must use http: or https:");
    }
    if (parsed.username || parsed.password) throw new Error("download url must not contain embedded credentials");
    return parsed.toString();
  }

  function sanitizeUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      parsed.username = "";
      parsed.password = "";
      for (const key of [...parsed.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, "__REDACTED__");
      }
      if (parsed.hash) parsed.hash = "__REDACTED_HASH__";
      return parsed.toString();
    } catch {
      return "";
    }
  }

  function normalizedPath(value) {
    return String(value || "").replace(/[\\/]+$/, "").toLowerCase();
  }

  function expectedPathMatches(filePath, expectedFilename) {
    const normalizedFile = String(filePath || "").replace(/\\/g, "/").toLowerCase();
    const normalizedExpected = String(expectedFilename || "").replace(/\\/g, "/").toLowerCase();
    return normalizedExpected ? normalizedFile.endsWith(`/${normalizedExpected}`) : false;
  }

  function pathAllowed(filePath, downloadDir) {
    if (!filePath || !downloadDir) return false;
    const separatorIndex = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
    return separatorIndex >= 0 &&
      normalizedPath(filePath.slice(0, separatorIndex)) === normalizedPath(downloadDir);
  }

  function baseName(filePath) {
    const separatorIndex = Math.max(String(filePath || "").lastIndexOf("\\"), String(filePath || "").lastIndexOf("/"));
    return separatorIndex >= 0 ? String(filePath).slice(separatorIndex + 1) : String(filePath || "");
  }

  function recordForItem(item, downloadId) {
    for (const record of records.values()) {
      if (record.nativeId === item.id) return record;
    }
    const id = downloadId || randomId();
    const record = {
      downloadId: id,
      nativeId: item.id,
      url: sanitizeUrl(item.finalUrl || item.url || ""),
      createdAt: Date.parse(item.startTime) || Date.now(),
      cancelRequestedAt: null,
      terminalAt: null,
    };
    records.set(id, record);
    return record;
  }

  function publicState(item, record) {
    if (!item) {
      if (record.terminalAt) return record.cancelRequestedAt ? "cancelled" : "unknown";
      return "starting";
    }
    if (item.state === "complete") return "complete";
    if (item.state === "interrupted") {
      return item.error === "USER_CANCELED" ? "cancelled" : "interrupted";
    }
    if (item.state === "in_progress") return item.paused ? "paused" : "in_progress";
    return "unknown";
  }

  function snapshot(item, record, downloadDir) {
    const state = publicState(item, record);
    const result = {
      downloadId: record.downloadId,
      state,
      url: item ? sanitizeUrl(item.url || record.url) : record.url,
      finalUrl: item ? sanitizeUrl(item.finalUrl || item.url || record.url) : record.url,
      name: item ? cleanLeaf(item.filename || baseName(record.url), "download") : undefined,
      progress: item
        ? {
            received: Number(item.bytesReceived) || 0,
            total: Number.isFinite(item.totalBytes) && item.totalBytes >= 0 ? item.totalBytes : null,
            fileSize: Number.isFinite(item.fileSize) && item.fileSize >= 0 ? item.fileSize : null,
          }
        : { received: 0, total: null, fileSize: null },
      paused: item ? item.paused === true : false,
      canResume: item ? item.canResume === true : false,
      danger: item && item.danger ? item.danger : "unknown",
      needsUserAction: Boolean(item && ["uncommon", "dangerous"].includes(item.danger)),
      startedAt: new Date(record.createdAt).toISOString(),
      endedAt: record.terminalAt ? new Date(record.terminalAt).toISOString() : null,
      error: item && item.error ? item.error : null,
      path: undefined,
      file: null,
    };
    if (state === "complete" && item && item.filename) {
      if (pathAllowed(item.filename, downloadDir)) result.path = item.filename;
      else result.fileError = "outside_allowed_directory";
    }
    if (["complete", "interrupted", "cancelled", "unknown"].includes(state) && !record.terminalAt) {
      record.terminalAt = Date.now();
    }
    return result;
  }

  async function findItem(nativeId) {
    if (!Number.isInteger(nativeId)) return null;
    const items = await chrome.downloads.search({ id: nativeId });
    return items[0] || null;
  }

  async function reconcile(record, downloadDir) {
    let item = await findItem(record.nativeId);
    if (!item && !record.nativeId) {
      const candidates = await chrome.downloads.search({
        startedAfter: new Date(record.createdAt - 1000).toISOString(),
        limit: 50,
      });
      const matches = candidates.filter(
        (candidate) =>
          sanitizeUrl(candidate.url) === record.url &&
          expectedPathMatches(candidate.filename, record.expectedFilename) &&
          Math.abs(Date.parse(candidate.startTime) - record.createdAt) < 10000 &&
          candidate.byExtensionId === chrome.runtime.id,
      );
      if (matches.length === 1) {
        record.nativeId = matches[0].id;
        item = matches[0];
        await persist();
      }
    }
    return snapshot(item, record, downloadDir);
  }

  async function start(params) {
    await ready();
    const url = validateUrl(params.url);
    const safeUrl = sanitizeUrl(url);
    const requestedFilename = params.filename ? cleanLeaf(params.filename) : undefined;
    const expectedFilename = `browser-mcp/${requestedFilename || cleanLeaf(new URL(url).pathname.split("/").pop(), "download")}`;
    const downloadId = typeof params.requestId === "string" && params.requestId ? params.requestId : randomId();
    const existing = records.get(downloadId);
    if (existing) {
      if (existing.url !== safeUrl || (existing.requestedFilename || undefined) !== requestedFilename) {
        throw new Error("download requestId was already used with different parameters");
      }
      return reconcile(existing, params.downloadDir);
    }
    const createdAt = Date.now();
    const record = {
      downloadId,
      nativeId: null,
      url: safeUrl,
      requestedFilename,
      expectedFilename,
      createdAt,
      cancelRequestedAt: null,
      terminalAt: null,
    };
    records.set(downloadId, record);
    pendingStarts.set(downloadId, record);
    await persist();
    let nativeId;
    try {
      const finalName = requestedFilename || cleanLeaf(new URL(url).pathname.split("/").pop(), "download");
      nativeId = await chrome.downloads.download({
        url,
        filename: `browser-mcp/${finalName}`,
        conflictAction: "uniquify",
        saveAs: false,
      });
      record.nativeId = nativeId;
      const item = await findItem(nativeId);
      if (item) {
        recordForItem(item, downloadId);
        record.nativeId = item.id;
      }
      if (item && item.filename && !pathAllowed(item.filename, params.downloadDir)) {
        record.terminalAt = Date.now();
        await chrome.downloads.cancel(item.id).catch(() => {});
        await persist();
        throw new Error(
          "configured download directory does not match Chrome's current Downloads/browser-mcp directory",
        );
      }
      await persist();
      return snapshot(item, record, params.downloadDir);
    } catch (error) {
      records.delete(downloadId);
      await persist();
      throw error;
    } finally {
      pendingStarts.delete(downloadId);
    }
  }

  async function list(params) {
    await ready();
    const discovered = await chrome.downloads.search({
      orderBy: ["-startTime"],
      limit: 50,
      startedAfter: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    for (const item of discovered) {
      if (item.state === "complete" && !pathAllowed(item.filename, params.downloadDir)) continue;
      if (item.byExtensionId === chrome.runtime.id || pathAllowed(item.filename, params.downloadDir)) {
        const record = recordForItem(item);
        if (item.state === "complete" || item.state === "interrupted") {
          record.terminalAt = Date.parse(item.endTime) || Date.now();
        }
      }
    }
    await persist();
    const output = [];
    for (const record of [...records.values()].sort((left, right) => right.createdAt - left.createdAt)) {
      const item = await findItem(record.nativeId);
      const value = snapshot(item, record, params.downloadDir);
      if (value.state === "complete" && value.fileError === "outside_allowed_directory") continue;
      output.push(value);
    }
    await persist();
    return { downloads: output.slice(0, 50) };
  }

  async function status(params) {
    await ready();
    const record = records.get(String(params.downloadId || ""));
    if (!record) throw new Error("download was not started by this MCP session");
    const timeoutMs = params.wait === true
      ? Math.min(300000, Math.max(100, Number(params.timeoutMs) || 30000))
      : 0;
    const startedAt = Date.now();
    let result = await reconcile(record, params.downloadDir);
    if (params.wait === true) {
      while (Date.now() - startedAt < timeoutMs) {
        if (["complete", "interrupted", "cancelled", "unknown"].includes(result.state) || result.needsUserAction) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
        result = await reconcile(record, params.downloadDir);
      }
    }
    const outcome = ["complete", "interrupted", "cancelled", "unknown"].includes(result.state)
      ? "terminal"
      : result.needsUserAction
        ? "user_action_required"
        : Date.now() - startedAt >= timeoutMs
          ? "timeout"
          : "terminal";
    if (params.wait === true) {
      result.wait = {
        outcome,
        timeoutMs,
        elapsedMs: Date.now() - startedAt,
      };
    }
    if (["complete", "interrupted", "cancelled", "unknown"].includes(result.state) && !record.terminalAt) {
      record.terminalAt = Date.now();
    }
    await persist();
    return result;
  }

  async function cancel(params) {
    await ready();
    const record = records.get(String(params.downloadId || ""));
    if (!record) throw new Error("download was not started by this MCP session");
    const item = await findItem(record.nativeId);
    if (item && item.state === "in_progress") {
      await chrome.downloads.cancel(item.id);
      record.cancelRequestedAt = Date.now();
      await persist();
    } else if (!item && !record.terminalAt) {
      record.cancelRequestedAt = Date.now();
      await persist();
    }
    return status({ downloadId: record.downloadId, downloadDir: params.downloadDir, wait: false });
  }

  chrome.downloads.onCreated.addListener((item) => {
    ready()
      .then(async () => {
        if (item.byExtensionId !== chrome.runtime.id) return;
        for (const [downloadId, record] of pendingStarts) {
          if (
            record.url === sanitizeUrl(item.url || item.finalUrl) &&
            expectedPathMatches(item.filename, record.expectedFilename) &&
            !record.nativeId
          ) {
            record.nativeId = item.id;
            recordForItem(item, downloadId);
            await persist();
            return;
          }
        }
        recordForItem(item);
        await persist();
      })
      .catch(() => {});
  });

  chrome.downloads.onChanged.addListener((delta) => {
    ready()
      .then(async () => {
        if (!delta.id || !delta.state) return;
        for (const record of records.values()) {
          if (record.nativeId !== delta.id) continue;
          if (delta.state.current === "complete" || delta.state.current === "interrupted") {
            record.terminalAt = Date.now();
          }
          if (record.cancelRequestedAt && delta.state.current === "in_progress") {
            await chrome.downloads.cancel(delta.id).catch(() => {});
          }
          await persist();
          return;
        }
      })
      .catch(() => {});
  });

  chrome.downloads.onErased.addListener((id) => {
    ready()
      .then(async () => {
        for (const record of records.values()) {
          if (record.nativeId !== id) continue;
          record.terminalAt = Date.now();
          await persist();
          return;
        }
      })
      .catch(() => {});
  });

  return { start, list, status, cancel };
})();
