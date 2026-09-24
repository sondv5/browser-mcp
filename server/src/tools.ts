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
    "Target tab id from browser_tabs. Omit to use the active tab of the last focused window. Pass it explicitly when working with other agents or when you must not touch the user's current tab.",
};

const REF = {
  type: "string",
  description:
    "Element ref from the most recent browser_snapshot, e.g. \"m3k2_14\". Refs are invalidated by a new snapshot or page navigation.",
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
    description: "Return a fresh browser_snapshot after the action-state workflow completes.",
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
    name: "browser_server_status",
    description:
      "Report bridge status: host/guest role, port, whether the browser extension is connected, pending commands.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_tabs",
    description: "List every open tab across all windows (tabId, title, url, active, windowId).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_open",
    description:
      "Open a new tab in the user's browser. Defaults to a background tab so the user's current view is not disturbed.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open. Defaults to about:blank." },
        active: {
          type: "boolean",
          description: "Foreground the new tab (default false).",
        },
        newWindow: {
          type: "boolean",
          description:
            "Open the tab in a fresh, unfocused window (same profile and logins). Useful to keep agent work visually separate from the user's windows.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_close",
    description: "Close a tab by id.",
    inputSchema: {
      type: "object",
      properties: { tabId: TAB_ID },
      additionalProperties: false,
    },
  },
  {
    name: "browser_detach",
    description:
      "Detach the debugger from one tab (tabId) or from every tab this hub attached. Use it to release the tab immediately and remove the 'being debugged' banner.",
    inputSchema: {
      type: "object",
      properties: { tabId: TAB_ID },
      additionalProperties: false,
    },
  },
  {
    name: "browser_handle_dialog",
    description:
      "Accept or dismiss a blocking JavaScript dialog (alert / confirm / prompt / beforeunload). Call browser_snapshot first: while a dialog is open it reports the dialog instead of the page.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID,
        accept: { type: "boolean", description: "true = OK/accept (default), false = Cancel/dismiss." },
        promptText: { type: "string", description: "Text to answer a prompt() dialog with." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_hover",
    description: "Hover an element (by snapshot ref) or a viewport point. Use for menus and tooltips that only appear on hover.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID,
        ref: REF,
        x: { type: "number" },
        y: { type: "number" },
        keepFocus: KEEP_FOCUS,
        focus: FOCUS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_select_option",
    description:
      "Select an option in a native <select> by value, visible label, or index. Optional waitFor/settle/snapshot fields return the post-action state.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID,
        ref: REF,
        value: { type: "string" },
        label: { type: "string" },
        index: { type: "integer" },
        ...ACTION_STATE_OPTIONS,
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_back",
    description:
      "Go back in the tab's navigation history. Optional action-state fields can wait for load/DOM conditions and return a refreshed snapshot.",
    inputSchema: {
      type: "object",
      properties: { tabId: TAB_ID, ...ACTION_STATE_OPTIONS },
      additionalProperties: false,
    },
  },
  {
    name: "browser_forward",
    description:
      "Go forward in the tab's navigation history. Optional action-state fields can wait for load/DOM conditions and return a refreshed snapshot.",
    inputSchema: {
      type: "object",
      properties: { tabId: TAB_ID, ...ACTION_STATE_OPTIONS },
      additionalProperties: false,
    },
  },
  {
    name: "browser_reload",
    description:       "Reload the tab. Optional waitFor/settle/snapshot fields wait for the resulting state.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID,
        ignoreCache: { type: "boolean", description: "Bypass the HTTP cache (default false)." },
        ...ACTION_STATE_OPTIONS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_upload_file",
    description:
      "Attach local files to a file input (by ref). Disabled unless the server was started with --upload-dir; paths outside those directories are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID,
        ref: REF,
        files: {
          type: "array",
          items: { type: "string" },
          description: "Absolute paths to files inside an allowed --upload-dir.",
        },
      },
      required: ["ref", "files"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_scroll",
    description:
      "Scroll to an element by ref, or scroll the page by deltaX/deltaY (default 600 down) using trusted wheel events.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID,
        ref: REF,
        deltaX: { type: "number" },
        deltaY: { type: "number" },
        keepFocus: KEEP_FOCUS,
        focus: FOCUS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_find",
    description:
      "Find text on the page and get refs for the matching elements. Useful on long pages where browser_snapshot caps at maxRefs.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID,
        query: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: 50, description: "Cap on results (default 20, max 50)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_tab_activate",
    description:
      "Bring a tab to the foreground (and focus its window). Use sparingly - only for human handoff like logins, 2FA or captchas.",
    inputSchema: {
      type: "object",
      properties: { tabId: TAB_ID },
      additionalProperties: false,
    },
  },
  {
    name: "browser_cdp",
    description:
      "Escape hatch: send a raw Chrome DevTools Protocol command to a tab (same session as browser_snapshot/evaluate). Use the purpose-built tools first - this is for advanced cases the tools do not cover.",
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
  {
    name: "browser_navigate",
    description:
      "Navigate a tab without stealing focus. Optional waitFor/settle/snapshot fields wait for load/DOM/network state and can return a fresh snapshot.",
    inputSchema: {
      type: "object",
      properties: { tabId: TAB_ID, url: { type: "string" }, ...ACTION_STATE_OPTIONS },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Accessibility-style outline of the page with a stable ref for every interactive element. This is the primary 'what is on screen' tool; call it before clicking or typing. Any new snapshot or navigation invalidates previous refs.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID,
        maxRefs: { type: "integer", description: "Cap on refs to emit (default 400)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description:
      "Click by snapshot ref (preferred) or viewport coordinates. Dispatches trusted input; optional waitFor/settle/snapshot fields return the resulting state.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID,
        ref: REF,
        x: { type: "number", description: "Viewport x when no ref is given." },
        y: { type: "number", description: "Viewport y when no ref is given." },
        button: { type: "string", enum: ["left", "right", "middle"] },
        keepFocus: KEEP_FOCUS,
        focus: FOCUS,
        ...ACTION_STATE_OPTIONS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description:
      "Type text into an element (optional ref to focus first), optionally submit, then wait for a requested DOM/load/network condition and snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID,
        ref: REF,
        text: { type: "string" },
        submit: { type: "boolean", description: "Press Enter after typing." },
        keepFocus: KEEP_FOCUS,
        focus: FOCUS,
        ...ACTION_STATE_OPTIONS,
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press_key",
    description:       "Press one key such as Enter, Tab, Escape, ArrowDown, or a character; optional action-state fields can wait and snapshot afterward.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID,
        key: { type: "string" },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["Alt", "Ctrl", "Meta", "Shift"] },
        },
        keepFocus: KEEP_FOCUS,
        focus: FOCUS,
        ...ACTION_STATE_OPTIONS,
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a PNG of the tab viewport or a single element by ref (both work on background tabs). Full-page capture needs a visible tab - call browser_tab_activate first.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID,
        fullPage: { type: "boolean", description: "Capture the whole page (requires a visible tab)." },
        ref: REF,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_get_text",
    description: "Read the visible text of an element (by ref) or of the whole page.",
    inputSchema: {
      type: "object",
      properties: { tabId: TAB_ID, ref: REF },
      additionalProperties: false,
    },
  },
  {
    name: "browser_evaluate",
    description:
      "Evaluate a JavaScript expression in the page and return its value. Use for reads and small mutations; it runs in the page's own world.",
    inputSchema: {
      type: "object",
      properties: { tabId: TAB_ID, expression: { type: "string" } },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait_for",
    description:
      "Wait until text, a CSS selector, an exact URL, page load, or tracked network idleness is reached (default timeout 10s).",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ID,
        text: { type: "string" },
        selector: { type: "string" },
        url: { type: "string", description: "Wait for this exact location.href." },
        visible: { type: "boolean", description: "With selector: also require the element to be rendered." },
        load: { type: "boolean", description: "Wait until document.readyState is complete." },
        networkIdle: { type: "boolean", description: "Wait until tracked CDP network requests have been idle." },
        timeoutMs: { type: "integer", minimum: 100, maximum: 300000, default: 10000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_download",
    description:
      "Start an HTTP or HTTPS download in Chrome's browser-mcp subdirectory. Disabled unless --download-dir is configured; the tool never reads or opens downloaded file contents.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1, maxLength: 8192 },
        filename: {
          type: "string",
          minLength: 1,
          maxLength: 180,
          description: "Optional leaf filename; path separators are rejected.",
        },
        requestId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[A-Za-z0-9._:-]+$",
          description: "Optional idempotency key. Reuse it to recover a download after a timeout.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_downloads",
    description:
      "List recent downloads managed in the configured browser-mcp directory, including page-initiated downloads.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_download_status",
    description:
      "Read a download's progress and terminal state. With wait=true, observe completion without cancelling it when the timeout expires.",
    inputSchema: {
      type: "object",
      properties: {
        downloadId: { type: "string", minLength: 1, maxLength: 128 },
        wait: { type: "boolean", default: false },
        timeoutMs: { type: "integer", minimum: 100, maximum: 300000, default: 30000 },
      },
      required: ["downloadId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_download_cancel",
    description:
      "Cancel an active download. Completed or interrupted downloads are returned unchanged; completed files are not deleted.",
    inputSchema: {
      type: "object",
      properties: { downloadId: { type: "string", minLength: 1, maxLength: 128 } },
      required: ["downloadId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_network_start",
    description:
      "Start bounded, memory-only network capture for one tab. Start before navigating; previous records are cleared by default and the buffer is not restored after extension restarts.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { ...TAB_ID, description: "Explicit tab id from browser_tabs." },
        clear: {
          type: "boolean",
          description: "Clear an existing capture and begin a new generation (default true).",
        },
      },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_network_requests",
    description:
      "List buffered network requests for a tab, newest first. Sensitive URL query values and headers are redacted; call browser_network_request for details.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { ...TAB_ID, description: "Explicit tab id from browser_tabs." },
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
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_network_request",
    description:
      "Get one buffered network request by opaque entryId. Bodies are omitted unless includeBody=true; requested body text is transient and may contain sensitive data.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { ...TAB_ID, description: "Explicit tab id from browser_tabs." },
        entryId: { type: "string", minLength: 1, maxLength: 128 },
        includeBody: {
          type: "boolean",
          description: "Return up to 32 KiB of transient request/response text (default false).",
        },
      },
      required: ["tabId", "entryId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_network_stop",
    description:
      "Stop network capture for a tab and erase its buffered records without detaching the debugger.",
    inputSchema: {
      type: "object",
      properties: { tabId: { ...TAB_ID, description: "Explicit tab id from browser_tabs." } },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_console",
    description: "Read buffered console messages and uncaught exceptions for the tab.",
    inputSchema: {
      type: "object",
      properties: { tabId: TAB_ID },
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
    case "browser_tabs":
      return textResult(await hub.execute("tabs_list"));
    case "browser_open":
      if (args.newWindow === true) {
        return textResult(await hub.execute("window_new", { url: args.url, focused: false }));
      }
      return textResult(
        await hub.execute("tab_new", { url: args.url, active: args.active === true }),
      );
    case "browser_close":
      return textResult(await hub.execute("tab_close", { tabId: args.tabId }));
    case "browser_detach":
      return textResult(await hub.execute("detach", { tabId: args.tabId }));
    case "browser_handle_dialog":
      return textResult(
        await hub.execute("dialog", {
          tabId: args.tabId,
          accept: args.accept !== false,
          promptText: args.promptText,
        }),
      );
    case "browser_hover":
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
    case "browser_select_option":
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
    case "browser_back":
      return textResult(
        await hub.execute("back", { tabId: args.tabId, ...actionParams(args) }, actionTimeout(args)),
      );
    case "browser_forward":
      return textResult(
        await hub.execute("forward", { tabId: args.tabId, ...actionParams(args) }, actionTimeout(args)),
      );
    case "browser_reload":
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
    case "browser_upload_file":
      return textResult(
        await hub.execute("upload", {
          tabId: args.tabId,
          ref: args.ref,
          files: validateUploadPaths(args.files, uploadDirs),
        }),
      );
    case "browser_scroll":
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
    case "browser_find":
      return textResult(
        await hub.execute("find", {
          tabId: args.tabId,
          query: args.query,
          maxResults: args.maxResults,
        }),
      );
    case "browser_tab_activate":
      return textResult(await hub.execute("tab_activate", { tabId: args.tabId }));
    case "browser_cdp":
      return textResult(
        await hub.execute("cdp", { tabId: args.tabId, method: args.method, params: args.params }),
      );
    case "browser_navigate":
      return textResult(
        await hub.execute(
          "navigate",
          { tabId: args.tabId, url: args.url, ...actionParams(args) },
          actionTimeout(args),
        ),
      );
    case "browser_snapshot": {
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
                "Call browser_handle_dialog { accept: true|false } to dismiss it, then snapshot again.",
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
    case "browser_click":
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
    case "browser_type": {
      const result = await hub.execute(
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
      );
      return textResult(result);
    }
    case "browser_press_key":
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
    case "browser_screenshot": {
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
    case "browser_get_text":
      return textResult(await hub.execute("get_text", { tabId: args.tabId, ref: args.ref }));
    case "browser_evaluate":
      return textResult(
        await hub.execute("evaluate", { tabId: args.tabId, expression: args.expression }),
      );
    case "browser_wait_for": {
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
    case "browser_download": {
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
    case "browser_downloads": {
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
    case "browser_download_status": {
      const configuredDir = requireDownloadDir(downloadDir);
      if (typeof args.downloadId !== "string" || !args.downloadId) {
        throw new Error("downloadId is required");
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
    case "browser_download_cancel": {
      const configuredDir = requireDownloadDir(downloadDir);
      if (typeof args.downloadId !== "string" || !args.downloadId) {
        throw new Error("downloadId is required");
      }
      const result = await hub.execute(
        "download_cancel",
        { downloadId: args.downloadId, downloadDir: configuredDir },
        15000,
      );
      return textResult(sanitizeDownloadSnapshot(result, configuredDir));
    }
    case "browser_network_start":
      return textResult(
        await hub.execute(
          "network_start",
          { tabId: args.tabId, clear: args.clear !== false },
          10000,
        ),
      );
    case "browser_network_requests":
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
    case "browser_network_request":
      return textResult(
        await hub.execute(
          "network_get",
          { tabId: args.tabId, entryId: args.entryId, includeBody: args.includeBody === true },
          15000,
        ),
      );
    case "browser_network_stop":
      return textResult(
        await hub.execute("network_stop", { tabId: args.tabId }, 10000),
      );
    case "browser_console":
      return textResult(await hub.execute("console_logs", { tabId: args.tabId }));
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function textResult(value: unknown): ToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}
