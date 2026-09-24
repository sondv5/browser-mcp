// Live test against a running hub + the real browser extension.
// Connects as a guest client over ws://127.0.0.1:8787/client and exercises every
// command on throwaway tabs. Does not touch any tab the user opened.
//
// Usage: node test/live.mjs [port]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || process.env.BROWSER_MCP_PORT || 8787);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uploadFile = path.join(os.tmpdir(), "browser-mcp-live.txt");
fs.writeFileSync(uploadFile, "live test");

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    console.error(`FAIL ${name}${detail !== undefined ? ` - ${detail}` : ""}`);
    failures.push(name);
  }
}

const socket = new WebSocket(`ws://127.0.0.1:${PORT}/client`);
let nextId = 1;
const pending = new Map();

socket.on("message", (data) => {
  const message = JSON.parse(String(data));
  if (message.kind === "reply" && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error?.message || "command failed"));
  }
});

function call(command, params = {}, timeoutMs = 30000) {
  const id = `live-${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ kind: "call", id, command, params, timeoutMs }));
  });
}

async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    check(name, false, String(error.message || error));
  }
}

async function expectError(name, promiseFactory, fragment) {
  try {
    await promiseFactory();
    check(name, false, "expected an error");
  } catch (error) {
    const message = String(error.message || error);
    check(name, !fragment || message.toLowerCase().includes(fragment.toLowerCase()), message);
  }
}

function refByRole(snapshotText, role, nameFragment) {
  for (const line of String(snapshotText || "").split("\n")) {
    if (!line.includes(`- ${role}`)) continue;
    if (nameFragment && !line.toLowerCase().includes(nameFragment.toLowerCase())) continue;
    const match = line.match(/\[ref=([^\]]+)\]/);
    if (match) return match[1];
  }
  return null;
}

async function newTab(url) {
  const created = await call("tab_new", { url, active: false });
  await call("wait_for", { tabId: created.tabId, selector: "h1", timeoutMs: 25000 });
  return created.tabId;
}

async function main() {
  await new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    setTimeout(() => reject(new Error("could not connect to the hub")), 5000);
  });
  socket.send(JSON.stringify({ kind: "hello", protocol: 1, role: "client", clientId: "live-test" }));

  const health = await call("__status", {});
  check("hub reachable", health && health.role === "host", JSON.stringify(health));
  check("extension connected", health.extensionConnected === true, "load/reload the extension and press Connect");
  if (!health.extensionConnected) {
    socket.close();
    return;
  }

  const tabs = await call("tabs_list", {});
  check("tabs_list", Array.isArray(tabs.tabs) && tabs.tabs.length > 0, `${tabs.tabs?.length} tabs`);
  const activeBefore = tabs.tabs.find((tab) => tab.active)?.tabId;

  const tabId = await newTab("https://example.com");

  // ---- example.com: read + click + history ----
  const snapshot = await call("snapshot", { tabId });
  const linkRef = refByRole(snapshot.text, "link", "");
  check("snapshot returns refs", snapshot.count >= 1 && !!linkRef, JSON.stringify({ count: snapshot.count, url: snapshot.url }));

  await step("get_text by ref", async () => {
    const text = await call("get_text", { tabId, ref: linkRef });
    check("get_text by ref", typeof text.text === "string" && text.text.length > 0 && text.text.length < 500, JSON.stringify(text).slice(0, 120));
  });
  await step("get_text whole page", async () => {
    const pageText = await call("get_text", { tabId });
    check("get_text whole page", /Example Domain/.test(pageText.text));
  });
  await step("evaluate", async () => {
    const evaluated = await call("evaluate", { tabId, expression: "document.title" });
    check("evaluate", evaluated.value === "Example Domain", String(evaluated.value));
  });

  await step("click", async () => {
    let sawActive = false;
    let polling = true;
    const poll = (async () => {
      while (polling) {
        try {
          const active = (await call("tabs_list", {})).tabs.find((tab) => tab.tabId === tabId)?.active;
          if (active) sawActive = true;
        } catch {
          // ignore poll errors
        }
        await sleep(40);
      }
    })();
    await call("click", { tabId, ref: linkRef });
    polling = false;
    await poll;
    await call("wait_for", { tabId, selector: "h1", timeoutMs: 20000 });
    const afterClick = await call("snapshot", { tabId });
    check("click follows the link", !/example\.com/.test(afterClick.url), afterClick.url);
    check("click never activated the tab", sawActive === false);
    const activeAfterClick = (await call("tabs_list", {})).tabs.find((tab) => tab.active)?.tabId;
    check("user tab focus restored after input", activeAfterClick === activeBefore, `expected ${activeBefore}, got ${activeAfterClick}`);
  });

  await step("back", async () => {
    const back = await call("back", { tabId });
    await call("wait_for", { tabId, text: "Example Domain", timeoutMs: 20000 });
    const afterBack = await call("snapshot", { tabId });
    check("back", back.ok === true && /example\.com/.test(afterBack.url), afterBack.url);
  });

  await step("forward", async () => {
    await call("forward", { tabId });
    await call("wait_for", { tabId, selector: "h1", timeoutMs: 20000 });
    const afterForward = await call("snapshot", { tabId });
    check("forward", !/example\.com/.test(afterForward.url), afterForward.url);
  });

  await step("reload", async () => {
    const reload = await call("reload", { tabId });
    await call("wait_for", { tabId, selector: "h1", timeoutMs: 20000 });
    const afterReload = await call("snapshot", { tabId });
    check("reload", reload.ok === true && afterReload.count >= 1, JSON.stringify(reload));
  });

  await expectError("stale ref after navigation fails loudly", () => call("click", { tabId, ref: linkRef }), "snapshot");

  // ---- wikipedia portal: type / select / hover / find ----
  await step("wiki portal", async () => {
    await call("navigate", { tabId, url: "https://www.wikipedia.org" });
    await call("wait_for", { tabId, selector: "#searchInput", visible: true, timeoutMs: 25000 });
    const portal = await call("snapshot", { tabId });
    const searchRef = refByRole(portal.text, "searchbox", "") || refByRole(portal.text, "textbox", "");
    const langRef = refByRole(portal.text, "combobox", "");
    check("portal snapshot has search + language select", !!searchRef && !!langRef, portal.text.slice(0, 300));

    await call("type", { tabId, ref: searchRef, text: "openai" });
    const typed = await call("evaluate", { tabId, expression: "document.querySelector('#searchInput').value" });
    check("type", typed.value === "openai", String(typed.value));

    await call("press_key", { tabId, key: "Escape" });
    check("press_key", true);

    const hovered = await call("hover", { tabId, ref: searchRef });
    check("hover", hovered.ok === true);

    const found = await call("find", { tabId, query: "Wikipedia" });
    check("find returns refs", found.count >= 1 && /\[[a-z0-9]+_\d+\]/.test(found.text), JSON.stringify(found).slice(0, 160));

    const selected = await call("select", { tabId, ref: langRef, label: "Deutsch" });
    const selectedValue = await call("evaluate", { tabId, expression: "document.querySelector('#searchLanguage').value" });
    check("select_option", selected.ok === true && selectedValue.value === "de", JSON.stringify({ selected, value: selectedValue.value }));
  });

  // ---- wikipedia article: scroll / element screenshot / dialog / upload ----
  await step("wiki article", async () => {
    await call("navigate", { tabId, url: "https://en.wikipedia.org/wiki/OpenAI" });
    await call("wait_for", { tabId, selector: "h1", timeoutMs: 25000 });
    const article = await call("snapshot", { tabId });
    const headingRef = refByRole(article.text, "heading", "");
    check("article snapshot has headings", !!headingRef, article.text.slice(0, 200));

    const before = await call("evaluate", { tabId, expression: "window.scrollY" });
    await call("scroll", { tabId, deltaY: 900 });
    await sleep(400);
    const after = await call("evaluate", { tabId, expression: "window.scrollY" });
    check("scroll by wheel", after.value > before.value, `${before.value} -> ${after.value}`);

    await call("scroll", { tabId, ref: headingRef });
    check("scroll to ref", true);

    const elementShot = await call("screenshot", { tabId, ref: headingRef });
    check("screenshot by ref", typeof elementShot.data === "string" && elementShot.data.length > 100, JSON.stringify({ w: elementShot.width, h: elementShot.height }));

    await call("evaluate", { tabId, expression: "setTimeout(() => alert('browser-mcp-live'), 50); 'scheduled'" });
    await sleep(500);
    const dialogSnapshot = await call("snapshot", { tabId });
    check("snapshot reports an open dialog", dialogSnapshot.dialog?.type === "alert", JSON.stringify(dialogSnapshot).slice(0, 160));

    await expectError("other tools fail while a dialog is open", () => call("evaluate", { tabId, expression: "1 + 1" }), "dialog");

    const handled = await call("dialog", { tabId, accept: true });
    check("handle_dialog", handled.ok === true && handled.handled === "alert", JSON.stringify(handled));

    const afterDialog = await call("snapshot", { tabId });
    check("snapshot works again after the dialog", !afterDialog.dialog && afterDialog.count >= 1);

    await call("evaluate", {
      tabId,
      expression:
        "(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'bb-upload'; i.setAttribute('aria-label', 'bb-upload-test'); document.body.appendChild(i); return 'ok'; })()",
    });
    const withInput = await call("snapshot", { tabId, maxRefs: 5000 });
    const fileRef = refByRole(withInput.text, "textbox", "bb-upload-test");
    check("injected file input appears in the snapshot", !!fileRef, withInput.text.slice(-200));
    const uploaded = await call("upload", { tabId, ref: fileRef, files: [uploadFile] });
    const files = await call("evaluate", { tabId, expression: "document.getElementById('bb-upload').files.length" });
    check("upload_file", uploaded.ok === true && files.value === 1, JSON.stringify({ uploaded, files: files.value }));

    const logs = await call("console_logs", { tabId });
    check("console_logs", Array.isArray(logs.entries));
  });

  await step("detach + close", async () => {
    const detached = await call("detach", { tabId });
    check("detach", detached.ok === true, JSON.stringify(detached));
    await call("tab_close", { tabId });
    check("tab_close", true);
  });

  socket.close();
}

try {
  await main();
} catch (error) {
  console.error(`FAIL harness: ${error.message}`);
  failures.push("harness");
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall live checks passed");
process.exit(0);
