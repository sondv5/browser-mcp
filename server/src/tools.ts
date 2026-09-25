import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  requireDownloadDir,
  sanitizeDownloadSnapshot,
  validateDownloadFilename,
  validateDownloadRequestId,
  validateDownloadUrl,
} from "./downloads.js";
import type { Hub } from "./hub.js";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type ToolResult = CallToolResult;

const TAB_ID = {
  type: "integer",
  description:
    "Target tab id from browser_tab { action: 'list' }. Omit to use the active tab of the last focused window. Pass it explicitly when working with other agents or when you must not touch the user's current tab.",
};

const REF = {
  type: "string",
  description:
    'Element ref from the most recent browser_read { action: \'snapshot\' }, e.g. "m3k2_14". Refs are invalidated by a new snapshot or page navigation.',
};

const KEEP_FOCUS = {
  type: "boolean",
  description:
    "Keep the tab focused for this action instead of borrowing focus for ~200ms and giving it back (default false).",
};

const FOCUS = {
  type: "string",
  enum: ["auto", "keep", "never", "emulate"],
  description:
    'How to make the tab accept trusted input. "auto" (default) tries silently via focus emulation, verifies the event landed, and only then borrows focus briefly; "keep" leaves the tab focused; "never" dispatches without any help; "emulate" forces the silent path.',
};

const ACTION_WAIT_FOR = {
  type: "object",
  properties: {
    selector: { type: "string" },
    text: { type: "string" },
    url: { type: "string", description: "Wait for this exact location.href." },
    visible: { type: "boolean", description: "With selector: require the element to be rendered." },
  },
  additionalProperties: false,
};

const ACTION_STATE_OPTIONS = {
  waitFor: ACTION_WAIT_FOR,
  settle: {
    type: "string",
    enum: ["load", "networkIdle", "both"],
    description: "Wait for page load, tracked network idleness, or both after the action.",
  },
  snapshot: {
    type: "boolean",
    description: "Return a fresh snapshot after the action-state workflow completes.",
  },
  timeoutMs: {
    type: "integer",
    minimum: 100,
    maximum: 300000,
    default: 30000,
    description: "Deadline for the complete post-action workflow.",
  },
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "browser_tab",
    description:
      "Manage tabs. action: 'list' (every open tab), 'open' (new background tab by default), 'close', 'activate' (foreground a tab for human handoff like login/2FA/captcha, use sparingly), 'navigate' (requires url, no focus steal), 'back', 'forward', 'reload', 'detach' (release debugger + remove the debug banner).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "open", "close", "activate", "navigate", "back", "forward", "reload", "detach"],
        },
        tabId: TAB_ID,
        url: { type: "string", description: "Required for action=navigate and action=open (defaults to about:blank)." },
        active: { type: "boolean", description: "action=open: foreground the new tab (default false)." },
        newWindow: {
          type: "boolean",
          description: "action=open: open in a fresh, unfocused window (same profile and logins).",
        },
        ignoreCache: { type: "boolean", description: "action=reload: bypass the HTTP cache (default false)." },
        ...ACTION_STATE_OPTIONS,
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_act",
    description:
      "Interact with the page. action: 'click' (by ref or x/y), 'type' (requires text, optional ref + submit), 'press_key' (requires key, e.g. Enter/Tab/Escape), 'hover' (menus/tooltips), 'scroll' (by ref or deltaX/deltaY, default 600 down), 'select' (native <select>, requires ref + value/label/index), 'upload' (attach files, requires ref + files inside --upload-dir), 'dialog' (accept/dismiss alert/confirm/prompt/beforeunload).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["click", "type", "press_key", "hover", "scroll", "select", "upload", "dialog"],
        },
        tabId: TAB_ID,
        ref: REF,
        x: { type: "number", description: "action=click/hover: viewport x when no ref is given." },
        y: { type: "number", description: "action=click/hover: viewport y when no ref is given." },
        text: { type: "string", description: "action=type: text to insert (required)." },
        submit: { type: "boolean", description: "action=type: press Enter after typing." },
        key: { type: "string", description: "action=press_key: key name, e.g. Enter, Tab, Escape, ArrowDown (required)." },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["Alt", "Ctrl", "Meta", "Shift"] },
        },
        button: { type: "string", enum: ["left", "right", "middle"] },
        value: { type: "string", description: "action=select: option value." },
        label: { type: "string", description: "action=select: visible option label." },
        index: { type: "integer", description: "action=select: option index." },
        files: {
          type: "array",
          items: { type: "string" },
          description: "action=upload: absolute paths inside an allowed --upload-dir (required).",
        },
        accept: { type: "boolean", description: "action=dialog: true = OK/accept (default), false = Cancel/dismiss." },
        promptText: { type: "string", description: "action=dialog: text to answer a prompt() with." },
        deltaX: { type: "number" },
        deltaY: { type: "number" },
        keepFocus: KEEP_FOCUS,
        focus: FOCUS,
        ...ACTION_STATE_OPTIONS,
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_read",
    description:
      "Observe the page. action: 'snapshot' (a11y outline + refs, call before click/type; reports a blocking dialog instead of the page), 'find' (requires query, get refs for matches on long pages), 'get_text' (element or page text), 'evaluate' (requires expression, run JS in the page), 'wait' (wait for text/selector/url/load/networkIdle, default 10s), 'console' (buffered console messages/exceptions), 'screenshot' (viewport or element PNG, works on background tabs; fullPage needs a visible tab).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["snapshot", "find", "get_text", "evaluate", "wait", "console", "screenshot"],
        },
        tabId: TAB_ID,
        ref: REF,
        query: { type: "string", description: "action=find: text to search for (required)." },
        maxResults: { type: "integer", minimum: 1, maximum: 50, description: "action=find: cap on results (default 20)." },
        maxRefs: { type: "integer", description: "action=snapshot: cap on refs to emit (default 400)." },
        expression: { type: "string", description: "action=evaluate: JS expression to run in the page (required)." },
        text: { type: "string", description: "action=wait: wait for this text." },
        selector: { type: "string", description: "action=wait: wait for this CSS selector." },
        url: { type: "string", description: "action=wait: wait for this exact location.href." },
        visible: { type: "boolean", description: "action=wait: with selector, also require the element to be rendered." },
        load: { type: "boolean", description: "action=wait: wait until document.readyState is complete." },
        networkIdle: { type: "boolean", description: "action=wait: wait until tracked CDP network requests have been idle." },
        timeoutMs: { type: "integer", minimum: 100, maximum: 300000, default: 10000 },
        fullPage: { type: "boolean", description: "action=screenshot: capture the whole page (requires a visible tab)." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_network",
    description:
      "Bounded (500-entry, memory-only) network capture for one tab. action: 'start' (call before navigating; requires tabId), 'list' (buffered requests, newest first; URLs/headers redacted), 'get' (one request by entryId; bodies only with includeBody=true, max 32 KiB transient text), 'stop' (erase the buffer without detaching the debugger).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "list", "get", "stop"] },
        tabId: { ...TAB_ID, description: "Explicit tab id (required for all network actions)." },
        entryId: { type: "string", minLength: 1, maxLength: 128, description: "action=get: opaque entry id (required)." },
        includeBody: { type: "boolean", description: "action=get: return up to 32 KiB of transient text (default false)." },
        clear: { type: "boolean", description: "action=start: clear an existing capture (default true)." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
        beforeSequence: { type: "integer", minimum: 1 },
        urlContains: { type: "string", maxLength: 512 },
        method: { type: "string", maxLength: 32 },
        resourceType: {
          type: "string",
          enum: [
            "Document",
            "Stylesheet",
            "Image",
            "Media",
            "Font",
            "Script",
            "TextTrack",
            "XHR",
            "Fetch",
            "Prefetch",
            "EventSource",
            "WebSocket",
            "Manifest",
            "SignedExchange",
            "Ping",
            "CSPViolationReport",
            "Preflight",
            "FedCM",
            "Other",
          ],
        },
        state: { type: "string", enum: ["pending", "success", "failed", "redirected"] },
      },
      required: ["action", "tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_download",
    description:
      "Download files via Chrome into Downloads/browser-mcp (needs --download-dir). action: 'start' (requires url), 'list' (recent downloads), 'status' (requires downloadId; wait=true observes completion without cancelling on timeout), 'cancel' (requires downloadId; never deletes completed files). Never reads/opens/executes file contents.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "list", "status", "cancel"] },
        url: { type: "string", minLength: 1, maxLength: 8192, description: "action=start: HTTP(S) URL (required)." },
        filename: {
          type: "string",
          minLength: 1,
          maxLength: 180,
          description: "action=start: optional leaf filename; path separators are rejected.",
        },
        requestId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[A-Za-z0-9._:-]+$",
          description: "action=start: optional idempotency key.",
        },
        downloadId: { type: "string", minLength: 1, maxLength: 128, description: "action=status/cancel: id (required)." },
        wait: { type: "boolean", default: false },
        timeoutMs: { type: "integer", minimum: 100, maximum: 300000, default: 30000 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_server_status",
    description:
      "Report bridge status: host/guest role, port, whether the browser extension is connected, pending commands.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_cdp",
    description:
      "Escape hatch: send a raw Chrome DevTools Protocol command to a tab (same session as snapshot/evaluate). Use the purpose-built tools first - this is for advanced cases the tools do not cover.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID,
        method: { type: "string", description: 'CDP method, e.g. "Page.captureScreenshot".' },
        params: { type: "object", description: "CDP parameters object." },
      },
      required: ["method"],
      additionalProperties: false,
    },
  },
];

export function registerTools(
  server: Server,
  hub: Hub,
  options: { uploadDirs?: string[]; downloadDir?: string } = {},
): void {
  const uploadDirs = (options.uploadDirs ?? []).map((dir) => {
    const resolved = path.resolve(dir);
    return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
  });
  const downloadDir = options.downloadDir ? path.resolve(options.downloadDir) : undefined;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return await dispatch(hub, name, args, uploadDirs, downloadDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      } satisfies ToolResult;
    }
  });
}

function validateUploadPaths(files: unknown, uploadDirs: string[]): string[] {
  if (!Array.isArray(files) || files.length === 0 || !files.every((file) => typeof file === "string")) {
    throw new Error("files must be a non-empty array of absolute paths");
  }
  if (uploadDirs.length === 0) {
    throw new Error(
      "file uploads are disabled - start the MCP server with --upload-dir <directory> (repeatable) to allow them",
    );
  }
  const resolved = files.map((file) => {
    if (!path.isAbsolute(file)) throw new Error("upload files must use absolute paths");
    const lexical = path.resolve(file);
    if (!existsSync(lexical)) throw new Error(`file not found: ${lexical}`);
    const lexicalStats = lstatSync(lexical);
    if (lexicalStats.isSymbolicLink()) throw new Error("symbolic-link upload files are not allowed");
    if (!statSync(lexical).isFile()) throw new Error(`not a regular file: ${lexical}`);
    return realpathSync.native(lexical);
  });
  for (const file of resolved) {
    const allowed = uploadDirs.some((dir) => {
      const relative = path.relative(dir, file);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (!allowed) {
      throw new Error(`path outside the allowed upload directories (${uploadDirs.join(", ")})`);
    }
  }
  return resolved;
}

function actionParams(args: Record<string, unknown>): Record<string, unknown> {
  return {
    waitFor: args.waitFor,
    settle: args.settle,
    snapshot: args.snapshot,
    timeoutMs: args.timeoutMs,
  };
}

function actionTimeout(args: Record<string, unknown>): number | undefined {
  const requested =
    args.waitFor !== undefined ||
    args.settle !== undefined ||
    args.snapshot !== undefined ||
    args.timeoutMs !== undefined;
  if (!requested) return undefined;
  const timeoutMs = Math.min(300000, Math.max(100, Number(args.timeoutMs) || 30000));
  return timeoutMs + 5000;
}

function requireString(args: Record<string, unknown>, field: string, toolAction: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required for ${toolAction}`);
  }
  return value;
}

async function dispatch(
  hub: Hub,
  name: string,
  args: Record<string, unknown>,
  uploadDirs: string[],
  downloadDir: string | undefined,
): Promise<ToolResult> {
  switch (name) {
    case "browser_server_status": {
      const status = { ...(await hub.status()), role: hub.role, clientPid: process.pid };
      return textResult(status);
    }
    case "browser_tab": {
      const action = args.action as string | undefined;
      switch (action) {
        case "list":
          return textResult(await hub.execute("tabs_list"));
        case "open":
          if (args.newWindow === true) {
            return textResult(await hub.execute("window_new", { url: args.url, focused: false }));
          }
          return textResult(
            await hub.execute("tab_new", { url: args.url, active: args.active === true }),
          );
        case "close":
          return textResult(await hub.execute("tab_close", { tabId: args.tabId }));
        case "activate":
          return textResult(await hub.execute("tab_activate", { tabId: args.tabId }));
        case "navigate":
          requireString(args, "url", "browser_tab { action: 'navigate' }");
          return textResult(
            await hub.execute(
              "navigate",
              { tabId: args.tabId, url: args.url, ...actionParams(args) },
              actionTimeout(args),
            ),
          );
        case "back":
          return textResult(
            await hub.execute("back", { tabId: args.tabId, ...actionParams(args) }, actionTimeout(args)),
          );
        case "forward":
          return textResult(
            await hub.execute("forward", { tabId: args.tabId, ...actionParams(args) }, actionTimeout(args)),
          );
        case "reload":
          return textResult(
            await hub.execute(
              "reload",
              {
                tabId: args.tabId,
                ignoreCache: args.ignoreCache === true,
                ...actionParams(args),
              },
              actionTimeout(args),
            ),
          );
        case "detach":
          return textResult(await hub.execute("detach", { tabId: args.tabId }));
        default:
          throw new Error(
            `unknown browser_tab action: ${String(action)} (expected list, open, close, activate, navigate, back, forward, reload, detach)`,
          );
      }
    }
    case "browser_act": {
      const action = args.action as string | undefined;
      switch (action) {
        case "click":
          return textResult(
            await hub.execute("click", {
              tabId: args.tabId,
              ref: args.ref,
              x: args.x,
              y: args.y,
              button: args.button,
              keepFocus: args.keepFocus === true,
              focus: args.focus,
              ...actionParams(args),
            }, actionTimeout(args)),
          );
        case "type":
          requireString(args, "text", "browser_act { action: 'type' }");
          return textResult(
            await hub.execute(
              "type",
              {
                tabId: args.tabId,
                ref: args.ref,
                text: args.text,
                submit: args.submit === true,
                keepFocus: args.keepFocus === true,
                focus: args.focus,
                ...actionParams(args),
              },
              actionTimeout(args),
            ),
          );
        case "press_key":
          requireString(args, "key", "browser_act { action: 'press_key' }");
          return textResult(
            await hub.execute("press_key", {
              tabId: args.tabId,
              key: args.key,
              modifiers: args.modifiers,
              keepFocus: args.keepFocus === true,
              focus: args.focus,
              ...actionParams(args),
            }, actionTimeout(args)),
          );
        case "hover":
          return textResult(
            await hub.execute("hover", {
              tabId: args.tabId,
              ref: args.ref,
              x: args.x,
              y: args.y,
              keepFocus: args.keepFocus === true,
              focus: args.focus,
            }),
          );
        case "scroll":
          return textResult(
            await hub.execute("scroll", {
              tabId: args.tabId,
              ref: args.ref,
              deltaX: args.deltaX,
              deltaY: args.deltaY,
              keepFocus: args.keepFocus === true,
              focus: args.focus,
            }),
          );
        case "select":
          if (args.ref === undefined) throw new Error("ref is required for browser_act { action: 'select' }");
          return textResult(
            await hub.execute("select", {
              tabId: args.tabId,
              ref: args.ref,
              value: args.value,
              label: args.label,
              index: args.index,
              ...actionParams(args),
            }, actionTimeout(args)),
          );
        case "upload":
          if (args.ref === undefined) throw new Error("ref is required for browser_act { action: 'upload' }");
          return textResult(
            await hub.execute("upload", {
              tabId: args.tabId,
              ref: args.ref,
              files: validateUploadPaths(args.files, uploadDirs),
            }),
          );
        case "dialog":
          return textResult(
            await hub.execute("dialog", {
              tabId: args.tabId,
              accept: args.accept !== false,
              promptText: args.promptText,
            }),
          );
        default:
          throw new Error(
            `unknown browser_act action: ${String(action)} (expected click, type, press_key, hover, scroll, select, upload, dialog)`,
          );
      }
    }
    case "browser_read": {
      const action = args.action as string | undefined;
      switch (action) {
        case "snapshot": {
          const snapshot = (await hub.execute("snapshot", {
            tabId: args.tabId,
            maxRefs: args.maxRefs,
          })) as {
            url?: string;
            title?: string;
            count?: number;
            viewport?: unknown;
            text?: string;
            dialog?: { type?: string; message?: string; defaultPrompt?: string };
          };
          if (snapshot.dialog) {
            return {
              content: [
                {
                  type: "text",
                  text: [
                    "A JavaScript dialog is blocking this tab.",
                    `Type: ${snapshot.dialog.type ?? "unknown"}`,
                    `Message: ${snapshot.dialog.message ?? ""}`,
                    snapshot.dialog.defaultPrompt ? `Default prompt: ${snapshot.dialog.defaultPrompt}` : "",
                    "",
                    "Call browser_act { action: 'dialog', accept: true|false } to dismiss it, then snapshot again.",
                  ]
                    .filter(Boolean)
                    .join("\n"),
                },
              ],
            };
          }
          const header = [
            `URL: ${snapshot.url ?? "unknown"}`,
            `Title: ${snapshot.title ?? ""}`,
            `Refs: ${snapshot.count ?? 0}`,
            `Viewport: ${JSON.stringify(snapshot.viewport ?? {})}`,
          ].join("\n");
          return { content: [{ type: "text", text: `${header}\n\n${snapshot.text ?? ""}` }] };
        }
        case "find":
          requireString(args, "query", "browser_read { action: 'find' }");
          return textResult(
            await hub.execute("find", {
              tabId: args.tabId,
              query: args.query,
              maxResults: args.maxResults,
            }),
          );
        case "get_text":
          return textResult(await hub.execute("get_text", { tabId: args.tabId, ref: args.ref }));
        case "evaluate":
          requireString(args, "expression", "browser_read { action: 'evaluate' }");
          return textResult(
            await hub.execute("evaluate", { tabId: args.tabId, expression: args.expression }),
          );
        case "wait": {
          const timeoutMs = Math.min(300000, Math.max(100, Number(args.timeoutMs) || 10000));
          return textResult(
            await hub.execute(
              "wait_for",
              {
                tabId: args.tabId,
                text: args.text,
                selector: args.selector,
                url: args.url,
                visible: args.visible === true,
                load: args.load === true,
                networkIdle: args.networkIdle === true,
                timeoutMs,
              },
              timeoutMs + 5000,
            ),
          );
        }
        case "console":
          return textResult(await hub.execute("console_logs", { tabId: args.tabId }));
        case "screenshot": {
          const shot = (await hub.execute("screenshot", {
            tabId: args.tabId,
            fullPage: args.fullPage === true,
            ref: args.ref,
          })) as { data: string; width?: number; height?: number };
          return {
            content: [
              { type: "image", data: shot.data, mimeType: "image/png" },
              { type: "text", text: `Captured ${shot.width ?? "?"}x${shot.height ?? "?"} PNG.` },
            ],
          };
        }
        default:
          throw new Error(
            `unknown browser_read action: ${String(action)} (expected snapshot, find, get_text, evaluate, wait, console, screenshot)`,
          );
      }
    }
    case "browser_download": {
      const action = args.action as string | undefined;
      switch (action) {
        case "start": {
          const configuredDir = requireDownloadDir(downloadDir);
          const result = await hub.execute(
            "download_start",
            {
              url: validateDownloadUrl(args.url),
              filename: validateDownloadFilename(args.filename),
              requestId: validateDownloadRequestId(args.requestId),
              downloadDir: configuredDir,
            },
            15000,
          );
          return textResult(sanitizeDownloadSnapshot(result, configuredDir));
        }
        case "list": {
          const configuredDir = requireDownloadDir(downloadDir);
          const result = (await hub.execute("download_list", { downloadDir: configuredDir }, 10000)) as {
            downloads?: unknown[];
          };
          return textResult({
            ...result,
            downloads: Array.isArray(result.downloads)
              ? result.downloads.map((download) => sanitizeDownloadSnapshot(download, configuredDir))
              : [],
          });
        }
        case "status": {
          const configuredDir = requireDownloadDir(downloadDir);
          if (typeof args.downloadId !== "string" || !args.downloadId) {
            throw new Error("downloadId is required for browser_download { action: 'status' }");
          }
          const wait = args.wait === true;
          const timeoutMs = wait
            ? Math.min(300000, Math.max(100, Number(args.timeoutMs) || 30000))
            : 0;
          const result = await hub.execute(
            "download_status",
            { downloadId: args.downloadId, wait, timeoutMs, downloadDir: configuredDir },
            wait ? timeoutMs + 5000 : 10000,
          );
          return textResult(sanitizeDownloadSnapshot(result, configuredDir));
        }
        case "cancel": {
          const configuredDir = requireDownloadDir(downloadDir);
          if (typeof args.downloadId !== "string" || !args.downloadId) {
            throw new Error("downloadId is required for browser_download { action: 'cancel' }");
          }
          const result = await hub.execute(
            "download_cancel",
            { downloadId: args.downloadId, downloadDir: configuredDir },
            15000,
          );
          return textResult(sanitizeDownloadSnapshot(result, configuredDir));
        }
        default:
          throw new Error(
            `unknown browser_download action: ${String(action)} (expected start, list, status, cancel)`,
          );
      }
    }
    case "browser_network": {
      const action = args.action as string | undefined;
      switch (action) {
        case "start":
          if (args.tabId === undefined) throw new Error("tabId is required for browser_network { action: 'start' }");
          return textResult(
            await hub.execute(
              "network_start",
              { tabId: args.tabId, clear: args.clear !== false },
              10000,
            ),
          );
        case "list":
          if (args.tabId === undefined) throw new Error("tabId is required for browser_network { action: 'list' }");
          return textResult(
            await hub.execute(
              "network_list",
              {
                tabId: args.tabId,
                limit: args.limit,
                beforeSequence: args.beforeSequence,
                urlContains: args.urlContains,
                method: args.method,
                resourceType: args.resourceType,
                state: args.state,
              },
              10000,
            ),
          );
        case "get":
          if (args.tabId === undefined) throw new Error("tabId is required for browser_network { action: 'get' }");
          if (typeof args.entryId !== "string" || !args.entryId) {
            throw new Error("entryId is required for browser_network { action: 'get' }");
          }
          return textResult(
            await hub.execute(
              "network_get",
              { tabId: args.tabId, entryId: args.entryId, includeBody: args.includeBody === true },
              15000,
            ),
          );
        case "stop":
          if (args.tabId === undefined) throw new Error("tabId is required for browser_network { action: 'stop' }");
          return textResult(
            await hub.execute("network_stop", { tabId: args.tabId }, 10000),
          );
        default:
          throw new Error(
            `unknown browser_network action: ${String(action)} (expected start, list, get, stop)`,
          );
      }
    }
    case "browser_cdp":
      return textResult(
        await hub.execute("cdp", { tabId: args.tabId, method: args.method, params: args.params }),
      );
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function textResult(value: unknown): ToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}
