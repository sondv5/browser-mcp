// Page-side expressions evaluated through Runtime.evaluate. Nothing here mutates
// the DOM: element refs live in an in-page Map on globalThis.__browserMcpRefs and
// are never written as attributes. Refs embed the snapshot epoch, so stale refs
// fail loudly instead of clicking the wrong element.
globalThis.pageScripts = (() => {
  function snapshotExpr(options) {
    const serialized = JSON.stringify(options || {});
    return `(() => {
      const opts = ${serialized};
      const maxRefs = opts.maxRefs || 400;
      const epoch = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const refs = new Map();
      let counter = 0;
      const lines = [];
      const roleFor = (el) => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        const tag = el.tagName;
        if (tag === "A") return "link";
        if (tag === "BUTTON") return "button";
        if (tag === "SELECT") return "combobox";
        if (tag === "TEXTAREA") return "textbox";
        if (tag === "SUMMARY") return "button";
        if (tag === "INPUT") {
          const type = (el.type || "text").toLowerCase();
          if (type === "hidden") return null;
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "submit" || type === "button" || type === "reset") return "button";
          if (type === "range") return "slider";
          if (type === "search") return "searchbox";
          return "textbox";
        }
        if (/^H[1-6]$/.test(tag)) return "heading";
        return null;
      };
      const nameOf = (el) => {
        const aria = el.getAttribute("aria-label");
        if (aria && aria.trim()) return aria.trim();
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const text = labelledBy
            .split(/\\s+/)
            .map((id) => { const node = document.getElementById(id); return node ? node.innerText || "" : ""; })
            .join(" ")
            .trim();
          if (text) return text;
        }
        const placeholder = el.getAttribute("placeholder");
        if (placeholder && placeholder.trim()) return placeholder.trim();
        const alt = el.getAttribute("alt");
        if (alt && alt.trim()) return alt.trim();
        const title = el.getAttribute("title");
        if (title && title.trim()) return title.trim();
        if (el.value !== undefined && el.type !== "password") {
          const value = String(el.value).trim();
          if (value && value.length <= 60) return value;
        }
        const text = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ");
        return text.slice(0, 90);
      };
      const visible = (el) => {
        if (!el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 && rect.height < 1) return false;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (el.closest("[aria-hidden=\\"true\\"]")) return false;
        return true;
      };
      const push = (el, depth) => {
        const role = roleFor(el);
        if (!role || !visible(el)) return;
        const bits = [role];
        const name = nameOf(el);
        if (name) bits.push(JSON.stringify(name));
        if (el.tagName === "INPUT") {
          if (el.type === "password") bits.push("(value: [redacted])");
          else if (el.type === "checkbox" || el.type === "radio") bits.push(el.checked ? "(checked)" : "(unchecked)");
        }
        if (el.disabled) bits.push("(disabled)");
        if (counter < maxRefs) {
          counter += 1;
          const ref = epoch + "_" + counter;
          refs.set(ref, el);
          bits.push("[ref=" + ref + "]");
        } else {
          bits.push("(no ref: maxRefs reached)");
        }
        lines.push("  ".repeat(Math.min(depth, 12)) + "- " + bits.join(" "));
      };
      const walk = (root, depth) => {
        for (const child of root.children || []) {
          push(child, depth);
          walk(child, depth + 1);
        }
      };
      walk(document.body || document.documentElement, 0);
      globalThis.__browserMcpRefs = { epoch, refs };
      return {
        url: location.href,
        title: document.title,
        epoch,
        count: counter,
        text: lines.join("\\n"),
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, dpr: devicePixelRatio },
      };
    })()`;
  }

  function resolveExpr(ref) {
    const serialized = JSON.stringify(ref);
    return `(() => {
      const state = globalThis.__browserMcpRefs;
      const ref = ${serialized};
      if (!state) return { ok: false, error: "no snapshot taken in this document yet - call browser_snapshot" };
      const sep = ref.lastIndexOf("_");
      const epoch = sep > 0 ? ref.slice(0, sep) : "";
      if (state.epoch !== epoch) return { ok: false, error: "stale ref - call browser_snapshot again" };
      const el = state.refs.get(ref);
      if (!el || !el.isConnected) return { ok: false, error: "ref not found - call browser_snapshot again" };
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 && rect.height < 1) return { ok: false, error: "element has no size (hidden?)" };
      return { ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`;
  }

  function textExpr(ref) {
    const serialized = JSON.stringify(ref);
    return `(() => {
      const state = globalThis.__browserMcpRefs;
      const ref = ${serialized};
      if (!state) return { ok: false, error: "no snapshot taken in this document yet - call browser_snapshot" };
      const el = state.refs.get(ref);
      if (!el) return { ok: false, error: "ref not found - call browser_snapshot again" };
      return { ok: true, text: String(el.innerText || el.textContent || "").slice(0, 20000) };
    })()`;
  }

  function predicateExpr(criteria) {
    const selector = JSON.stringify((criteria && criteria.selector) || null);
    const text = JSON.stringify((criteria && criteria.text) || null);
    const visibleFlag = criteria && criteria.visible ? "true" : "false";
    return `(() => {
      if (${selector}) {
        const el = document.querySelector(${selector});
        if (!el) return false;
        if (${visibleFlag}) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 1 && rect.height < 1) return false;
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
        }
        return true;
      }
      if (${text}) return ((document.body && document.body.innerText) || "").includes(${text});
      return true;
    })()`;
  }

  function waitExpr(criteria, timeoutMs) {
    const serialized = JSON.stringify(criteria || {});
    return `(async () => {
      const criteria = ${serialized};
      const timeoutMs = ${Math.max(100, Number(timeoutMs) || 10000)};
      const check = () => {
        if (typeof criteria.selector === "string") {
          let element;
          try {
            element = document.querySelector(criteria.selector);
          } catch (error) {
            return { ok: false, error: "invalid selector: " + String(error && error.message || error) };
          }
          if (!element) return null;
          if (criteria.visible) {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            if (rect.width < 1 && rect.height < 1) return null;
            if (style.display === "none" || style.visibility === "hidden") return null;
          }
        }
        if (typeof criteria.text === "string" && !((document.body && document.body.innerText) || "").includes(criteria.text)) {
          return null;
        }
        if (typeof criteria.url === "string" && location.href !== criteria.url) return null;
        if (criteria.load === true && document.readyState !== "complete") return null;
        if (
          typeof criteria.selector !== "string" &&
          typeof criteria.text !== "string" &&
          typeof criteria.url !== "string" &&
          criteria.load !== true
        ) {
          return { ok: false, error: "wait condition is required" };
        }
        return { ok: true, url: location.href, title: document.title, documentState: document.readyState };
      };
      const immediate = check();
      if (immediate && immediate.ok) return immediate;
      if (immediate && !immediate.ok) return immediate;
      return await new Promise((resolve) => {
        let timer = null;
        let observer = null;
        const events = ["DOMContentLoaded", "load", "popstate", "hashchange"];
        const finish = (result) => {
          if (timer) clearTimeout(timer);
          if (observer) observer.disconnect();
          for (const event of events) window.removeEventListener(event, verify);
          resolve(result);
        };
        const verify = () => {
          const result = check();
          if (result) finish(result);
        };
        observer = new MutationObserver(verify);
        observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, characterData: true });
        for (const event of events) window.addEventListener(event, verify);
        timer = setTimeout(() => finish({ ok: false, error: "condition not met before timeout" }), timeoutMs);
        verify();
      });
    })()`;
  }

  function objectExpr(ref) {
    const serialized = JSON.stringify(ref);
    return `(() => {
      const state = globalThis.__browserMcpRefs;
      const ref = ${serialized};
      if (!state) return null;
      return state.refs.get(ref) || null;
    })()`;
  }

  function rectExpr(ref) {
    const serialized = JSON.stringify(ref);
    return `(() => {
      const state = globalThis.__browserMcpRefs;
      const ref = ${serialized};
      if (!state) return { ok: false, error: "no snapshot taken in this document yet - call browser_snapshot" };
      const el = state.refs.get(ref);
      if (!el || !el.isConnected) return { ok: false, error: "ref not found - call browser_snapshot again" };
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 && rect.height < 1) return { ok: false, error: "element has no size (hidden?)" };
      return {
        ok: true,
        x: Math.floor(rect.left + scrollX),
        y: Math.floor(rect.top + scrollY),
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height),
      };
    })()`;
  }

  function scrollToExpr(ref) {
    const serialized = JSON.stringify(ref);
    return `(() => {
      const state = globalThis.__browserMcpRefs;
      const ref = ${serialized};
      if (!state) return { ok: false, error: "no snapshot taken in this document yet - call browser_snapshot" };
      const el = state.refs.get(ref);
      if (!el || !el.isConnected) return { ok: false, error: "ref not found - call browser_snapshot again" };
      el.scrollIntoView({ block: "start", inline: "nearest" });
      return { ok: true };
    })()`;
  }

  function selectExpr(ref, criteria) {
    const serialized = JSON.stringify(ref);
    const serializedCriteria = JSON.stringify(criteria || {});
    return `(() => {
      const state = globalThis.__browserMcpRefs;
      const ref = ${serialized};
      const criteria = ${serializedCriteria};
      if (!state) return { ok: false, error: "no snapshot taken in this document yet - call browser_snapshot" };
      const el = state.refs.get(ref);
      if (!el || !el.isConnected) return { ok: false, error: "ref not found - call browser_snapshot again" };
      if (el.tagName !== "SELECT") return { ok: false, error: "element is <" + el.tagName.toLowerCase() + ">, not a <select>" };
      const options = Array.from(el.options);
      let option = null;
      if (criteria.value !== undefined && criteria.value !== null) {
        option = options.find((candidate) => candidate.value === String(criteria.value)) || null;
      }
      if (!option && criteria.label) {
        const needle = String(criteria.label).toLowerCase();
        option =
          options.find((candidate) => (candidate.label || candidate.textContent || "").trim().toLowerCase() === needle) ||
          options.find((candidate) => (candidate.label || candidate.textContent || "").toLowerCase().includes(needle)) ||
          null;
      }
      if (!option && typeof criteria.index === "number") option = options[criteria.index] || null;
      if (!option) {
        return {
          ok: false,
          error: "no matching option",
          available: options.slice(0, 20).map((candidate) => candidate.value + " | " + (candidate.label || candidate.textContent || "").trim()),
        };
      }
      el.value = option.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        ok: true,
        selected: {
          value: option.value,
          label: (option.label || option.textContent || "").trim(),
          index: options.indexOf(option),
        },
      };
    })()`;
  }

  function findExpr(query, maxResults) {
    const serialized = JSON.stringify(String(query === undefined || query === null ? "" : query));
    const limit = Math.min(50, Math.max(1, Number(maxResults) || 20));
    return `(() => {
      const query = ${serialized};
      const max = ${limit};
      if (!query) return { ok: false, error: "query is required" };
      const needle = query.toLowerCase();
      let state = globalThis.__browserMcpRefs;
      if (!state) {
        globalThis.__browserMcpRefs = state = {
          epoch: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          refs: new Map(),
        };
      }
      let counter = state.refs.size;
      const matched = [];
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode() && matched.length < max) {
        const el = walker.currentNode;
        const text = (el.innerText || el.textContent || "").trim();
        if (!text) continue;
        const own = Array.from(el.childNodes)
          .filter((node) => node.nodeType === 3)
          .map((node) => node.textContent)
          .join(" ")
          .trim();
        const haystack = (own || text).toLowerCase();
        const attributes = (
          (el.getAttribute("aria-label") || "") +
          " " +
          (el.getAttribute("placeholder") || "") +
          " " +
          (el.getAttribute("title") || "") +
          " " +
          (el.getAttribute("alt") || "")
        ).toLowerCase();
        if (!haystack.includes(needle) && !attributes.includes(needle)) continue;
        if (matched.some((entry) => entry.el.contains(el))) continue;
        counter += 1;
        const ref = state.epoch + "_" + counter;
        state.refs.set(ref, el);
        const interactive = ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) || !!el.getAttribute("role");
        matched.push({
          el,
          line: "- [" + ref + "] " + (interactive ? el.tagName.toLowerCase() : "text") + " " + JSON.stringify(text.replace(/\\s+/g, " ").slice(0, 120)),
        });
      }
      const lines = matched.slice(0, max).map((entry) => entry.line);
      return { ok: true, count: Math.min(matched.length, max), epoch: state.epoch, text: lines.join("\\n") };
    })()`;
  }

  return { snapshotExpr, resolveExpr, textExpr, predicateExpr, waitExpr, objectExpr, rectExpr, scrollToExpr, selectExpr, findExpr };
})();
