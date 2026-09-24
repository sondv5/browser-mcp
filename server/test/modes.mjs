// Clean test of the three delivery paths, using focus overrides so the extension
// does not silently fix things for us:
//   A) fresh background tab, focus:"never"          -> expect 0 events
//   B) same tab, focus emulation + focus:"never"    -> silent path works?
//   C) fresh background tab, focus:"auto"           -> should land, and without
//      activating the tab (polled while the click runs)
//   D) tab in a separate unfocused window, auto     -> lands, or fails loudly
import WebSocket from "ws";

const socket = new WebSocket(`ws://127.0.0.1:${Number(process.argv[2] || 8787)}/client`);
let id = 0;
const pending = new Map();
socket.on("message", (data) => {
  const message = JSON.parse(String(data));
  if (message.kind === "reply" && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    message.ok ? entry.resolve(message.result) : entry.reject(new Error(message.error?.message));
  }
});
function call(command, params = {}, timeoutMs = 25000) {
  const callId = `m-${id++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    pending.set(callId, { resolve, reject, timer });
    socket.send(JSON.stringify({ kind: "call", id: callId, command, params, timeoutMs }));
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const arm = `(() => { window.__c = 0; document.addEventListener('click', () => window.__c++, true); return 'armed'; })()`;
const headingRef = (text) => (text.split("\n").find((l) => l.includes("- heading")) || "").match(/\[ref=([^\]]+)\]/)?.[1];
const clicks = async (tabId) => (await call("evaluate", { tabId, expression: "window.__c || 0" })).value;

await new Promise((resolve) => socket.once("open", resolve));
socket.send(JSON.stringify({ kind: "hello", protocol: 1, role: "client", clientId: "modes" }));

const userActive = (await call("tabs_list", {})).tabs.find((t) => t.active)?.tabId;

// A + B: fresh background tab, delivery control then emulation
const tabA = (await call("tab_new", { url: "https://example.com", active: false })).tabId;
await call("wait_for", { tabId: tabA, selector: "h1" });
const refA = headingRef((await call("snapshot", { tabId: tabA })).text);
await call("evaluate", { tabId: tabA, expression: arm });
await call("click", { tabId: tabA, ref: refA, focus: "never" });
await sleep(300);
console.log("A) fresh background tab, focus:never      ->", await clicks(tabA), "(expect 0)");

await call("cdp", { tabId: tabA, method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } });
await call("cdp", { tabId: tabA, method: "Page.setWebLifecycleState", params: { state: "active" } });
await call("evaluate", { tabId: tabA, expression: arm });
await call("click", { tabId: tabA, ref: refA, focus: "never" });
await sleep(300);
console.log("B) fresh background tab, emulation        ->", await clicks(tabA), "(expect > 0 if silent path works)");

// C: fresh background tab with the real auto path, polling for activation
const tabC = (await call("tab_new", { url: "https://example.com", active: false })).tabId;
await call("wait_for", { tabId: tabC, selector: "h1" });
const refC = headingRef((await call("snapshot", { tabId: tabC })).text);
await call("evaluate", { tabId: tabC, expression: arm });

let sawActive = false;
let polling = true;
const poll = (async () => {
  while (polling) {
    try {
      const active = (await call("tabs_list", {})).tabs.find((t) => t.tabId === tabC)?.active;
      if (active) sawActive = true;
    } catch {
      // ignore poll errors
    }
    await sleep(40);
  }
})();
await call("click", { tabId: tabC, ref: refC, focus: "auto" });
polling = false;
await poll;
console.log("C) auto path landed                       ->", await clicks(tabC), "(expect > 0)");
console.log("C) tab was activated during click         ->", sawActive, "(expect false if silent path works)");

const activeAfter = (await call("tabs_list", {})).tabs.find((t) => t.active)?.tabId;
console.log("C) user's active tab unchanged            ->", activeAfter === userActive, `(${activeAfter} vs ${userActive})`);

// D: separate unfocused window
let windowResult = "n/a";
try {
  const win = await call("window_new", { url: "https://example.com", focused: false, left: 80, top: 80, width: 1000, height: 700 });
  await call("wait_for", { tabId: win.tabId, selector: "h1", timeoutMs: 20000 });
  const refD = headingRef((await call("snapshot", { tabId: win.tabId })).text);
  await call("evaluate", { tabId: win.tabId, expression: arm });
  await call("click", { tabId: win.tabId, ref: refD, focus: "auto" });
  await sleep(400);
  windowResult = `${await clicks(win.tabId)} clicks`;
  await call("tab_close", { tabId: win.tabId });
} catch (error) {
  windowResult = `failed: ${error.message}`;
}
console.log("D) separate unfocused window              ->", windowResult);

await call("tab_close", { tabId: tabA });
await call("tab_close", { tabId: tabC });
socket.close();
