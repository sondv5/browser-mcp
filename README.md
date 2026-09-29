# browser-mcp

> Let AI drive the Chrome you already use — same logins, cookies, no separate browser, never steals your active tab.

MCP server + Chrome extension (MV3). The agent works in background tabs while you keep browsing.

## Setup (3 steps)

**1. Install the extension:**
https://chromewebstore.google.com/detail/browser-mcp-bridge/ieijpbldkdjgncbbjndoolkkgaamlocl

**2. Open the extension popup → Save & reconnect.** Badge `ON` = connected. Token is optional (default `null` = no auth, leave empty on both sides).

**3. Add the MCP server:**

opencode (`opencode.json`):
```json
{
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["npx", "-y", "@sondv5/browser-mcp@latest", "--extension-id", "ieijpbldkdjgncbbjndoolkkgaamlocl"],
      "enabled": true
    }
  }
}
```

Claude Code:
```bash
claude mcp add browser -- npx -y @sondv5/browser-mcp@latest --extension-id ieijpbldkdjgncbbjndoolkkgaamlocl
```

Restart your agent and you're done.

> Optional: add `--port 8787 --token YOUR_TOKEN` on both the server and the extension popup if you want shared-secret auth.

## Tools (7 tools)

| Tool | Does what |
| --- | --- |
| `browser_tab` | List / open / close / switch tabs, navigate (always in background) |
| `browser_act` | Click, type, keys, hover, scroll, select dropdown, upload, handle dialogs |
| `browser_read` | Read the page: snapshot, find text, get text, run JS, wait, console, screenshot |
| `browser_network` | Capture network: start / list / get / stop |
| `browser_download` | Download files: start / list / status / cancel |
| `browser_server_status` | Check extension connection status |
| `browser_cdp` | Raw CDP command escape hatch (advanced) |

Typical flow: `snapshot` → get `ref` → `click` / `type`.

See `server/README.md` for dev/build details.
