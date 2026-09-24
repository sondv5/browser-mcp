globalThis.browserMcpAction = (() => {
  const SETTLE_MODES = new Set(["load", "networkIdle", "both"]);

  function normalizeOptions(params) {
    const waitFor = params && params.waitFor && typeof params.waitFor === "object"
      ? {
          selector: params.waitFor.selector,
          text: params.waitFor.text,
          url: params.waitFor.url,
          visible: params.waitFor.visible === true,
        }
      : undefined;
    const hasWaitFor = Boolean(
      waitFor &&
        (typeof waitFor.selector === "string" ||
          typeof waitFor.text === "string" ||
          typeof waitFor.url === "string"),
    );
    if (waitFor && !hasWaitFor) throw new Error("waitFor requires selector, text, or url");
    const settle = params && params.settle;
    if (settle !== undefined && !SETTLE_MODES.has(settle)) {
      throw new Error('settle must be "load", "networkIdle", or "both"');
    }
    const timeoutMs = Math.min(300000, Math.max(100, Number(params && params.timeoutMs) || 30000));
    const snapshot = params && params.snapshot === true;
    return {
      requested: hasWaitFor || Boolean(settle) || snapshot || params?.timeoutMs !== undefined,
      waitFor: hasWaitFor ? waitFor : undefined,
      settle,
      timeoutMs,
      snapshot,
    };
  }

  function waitedLabels(options) {
    const labels = [];
    if (options.waitFor?.selector) labels.push(`selector:${options.waitFor.selector}`);
    if (options.waitFor?.text) labels.push(`text:${options.waitFor.text}`);
    if (options.waitFor?.url) labels.push(`url:${options.waitFor.url}`);
    return labels;
  }

  function stateResult({ options, startedAt, beforeNavigation, afterNavigation, page, networkIdle }) {
    const before = typeof beforeNavigation === "number" ? { total: beforeNavigation, committed: 0, sameDocument: 0 } : beforeNavigation;
    const after = typeof afterNavigation === "number" ? { total: afterNavigation, committed: 0, sameDocument: 0 } : afterNavigation;
    const navigation = after.committed > before.committed
      ? "committed"
      : after.sameDocument > before.sameDocument
        ? "same-document"
        : "none";
    return {
      phase: "settled",
      durationMs: Date.now() - startedAt,
      url: page?.url,
      title: page?.title,
      documentState: page?.documentState,
      navigation,
      networkIdle: options.settle === "networkIdle" || options.settle === "both" ? networkIdle : undefined,
      waited: waitedLabels(options),
      snapshot: options.snapshot,
    };
  }

  return { normalizeOptions, waitedLabels, stateResult };
})();
