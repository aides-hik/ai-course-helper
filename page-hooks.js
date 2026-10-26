  // Optional page hooks: probes must never change a native call's result.
  const pageApply = Reflect.apply;
  const pageNoop = () => {};
  const pageOwnValue = (object, key) => {
    if ((typeof object !== "object" || object === null) && typeof object !== "function") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value") ? descriptor.value : undefined;
  };
  const isZhsHost = (location) => {
    try {
      const hostname = typeof location?.hostname === "string" ? location.hostname.toLowerCase().replace(/\.$/, "") : "";
      return hostname === "zhihuishu.com" || hostname.endsWith(".zhihuishu.com");
    } catch { return false; }
  };
  const pageDisposeOnHide = (dispose, suspend = pageNoop, resume = pageNoop) => {
    let suspended = false;
    const hide = (event) => {
      if (!event?.persisted) return dispose();
      if (suspended) return;
      suspended = true;
      try { suspend(); } catch {}
    };
    const show = (event) => {
      if (!event?.persisted || !suspended) return;
      suspended = false;
      try { resume(); } catch {}
    };
    try {
      _unsafeWindow.addEventListener?.("pagehide", hide);
      _unsafeWindow.addEventListener?.("pageshow", show);
    } catch {}
    return () => {
      try { _unsafeWindow.removeEventListener?.("pagehide", hide); } catch {}
      try { _unsafeWindow.removeEventListener?.("pageshow", show); } catch {}
    };
  };

  let pageTimerHook = null;
  const hookError = () => {
    if (pageTimerHook) return pageTimerHook.dispose;
    const target = _unsafeWindow;
    const originals = {setInterval: target.setInterval, setTimeout: target.setTimeout};
    if (typeof originals.setInterval !== "function" || typeof originals.setTimeout !== "function") return pageNoop;
    const wrappers = {};
    for (const key of Object.keys(originals)) {
      wrappers[key] = function(...args) {
        try {
          if (String(new Error().stack || "").includes("checkoutNotTrustScript")) return -1;
        } catch {}
        return pageApply(originals[key], this, args);
      };
    }
    let disposed = false;
    let removeHideListener = pageNoop;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      for (const key of Object.keys(originals)) {
        try { if (target[key] === wrappers[key]) target[key] = originals[key]; } catch {}
      }
      removeHideListener();
      if (pageTimerHook?.dispose === dispose) pageTimerHook = null;
    };
    try {
      target.setInterval = wrappers.setInterval;
      target.setTimeout = wrappers.setTimeout;
    } catch { dispose(); return pageNoop; }
    pageTimerHook = {dispose};
    removeHideListener = pageDisposeOnHide(dispose);
    return dispose;
  };

  const pageXhrHooks = new WeakMap();
  class XMLHttpRequestInterceptor {
    constructor(urlList, callback) {
      this.dispose = pageNoop;
      const prototype = _unsafeWindow.XMLHttpRequest?.prototype;
      if (!prototype || typeof prototype.open !== "function" || typeof callback !== "function") return;
      let state = pageXhrHooks.get(prototype);
      if (!state || prototype.open !== state.wrapped) {
        state = {original: prototype.open, subscribers: new Set(), requests: new WeakMap(), records: new Set()};
        state.wrapped = function(...args) {
          const result = pageApply(state.original, this, args);
          try {
            // The native method already coerced URL-like objects. Inspect strings
            // only, so a caller's custom URL conversion never runs a second time.
            const url = typeof args[1] === "string" ? args[1] : "";
            state.requests.get(this)?.cleanup();
            const matched = [...state.subscribers].filter((entry) => entry.active && !entry.suspended && entry.parts.some((part) => url.includes(part)));
            if (!matched.length) return result;
            const entries = matched.map((entry) => ({entry, sequence: ++entry.sequence}));
            const xhr = this;
            let cleaned = false;
            const record = {
              entries, xhr,
              cleanup: () => {
                if (cleaned) return;
                cleaned = true;
                for (const type of ["load", "loadend", "abort", "error", "timeout"]) {
                  try { xhr.removeEventListener(type, type === "load" ? load : record.cleanup); } catch {}
                }
                if (state.requests.get(xhr) === record) state.requests.delete(xhr);
                state.records.delete(record);
              }
            };
            const load = () => {
              record.cleanup();
              let successful = false;
              try { successful = xhr.status >= 200 && xhr.status < 300; } catch {}
              if (!successful) return;
              for (const {entry, sequence} of entries) {
                if (!entry.active || entry.suspended || entry.sequence !== sequence) continue;
                try { entry.callback(null, "load"); } catch {}
              }
            };
            state.requests.set(xhr, record);
            state.records.add(record);
            try {
              xhr.addEventListener("load", load);
              for (const type of ["loadend", "abort", "error", "timeout"]) xhr.addEventListener(type, record.cleanup);
            } catch { record.cleanup(); return result; }
            for (const {entry} of entries) {
              if (!entry.active || entry.suspended) continue;
              try { entry.callback(null, "start"); } catch {}
            }
          } catch {}
          return result;
        };
        try { prototype.open = state.wrapped; } catch { return; }
        if (prototype.open !== state.wrapped) return;
        pageXhrHooks.set(prototype, state);
      }
      const entry = {parts: Array.isArray(urlList) ? urlList.filter((part) => typeof part === "string" && part) : [], callback, active: true, suspended: false, sequence: 0};
      state.subscribers.add(entry);
      let removeHideListener = pageNoop;
      this.dispose = () => {
        if (!entry.active) return;
        entry.active = false;
        state.subscribers.delete(entry);
        for (const record of [...state.records]) {
          if (!record.entries.some(({entry: listener}) => listener.active && !listener.suspended)) record.cleanup();
        }
        if (!state.subscribers.size) {
          try { if (prototype.open === state.wrapped) prototype.open = state.original; } catch {}
          if (pageXhrHooks.get(prototype) === state) pageXhrHooks.delete(prototype);
        }
        removeHideListener();
      };
      removeHideListener = pageDisposeOnHide(this.dispose, () => {
        if (!entry.active) return;
        entry.suspended = true;
        ++entry.sequence;
        for (const record of [...state.records]) {
          if (!record.entries.some(({entry: listener}) => listener.active && !listener.suspended)) record.cleanup();
        }
        // Cancel the still-mounted solver before the document enters BFCache.
        try { entry.callback(null, "start"); } catch {}
      }, () => {
        if (!entry.active) return;
        entry.suspended = false;
        // The same Vue instance survives BFCache. Ask it to rescan the current
        // question even when no new network request occurs after returning.
        try { entry.callback(null, "resume"); } catch {}
      });
    }
  }

  let pageCallHook = null;
  const hookWebpack = () => {
    if (pageCallHook) return pageCallHook.dispose;
    const prototype = _unsafeWindow.Function?.prototype;
    const original = prototype?.call;
    if (typeof original !== "function") return pageNoop;
    let disposed = false;
    let patchedPlugin;
    let probing = false;
    let originalInstallDescriptor;
    let wrappedInstall;
    let removeHideListener = pageNoop;
    const restoreCall = () => {
      try { if (prototype.call === wrapped) prototype.call = original; } catch {}
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      restoreCall();
      try {
        if (patchedPlugin && pageOwnValue(patchedPlugin, "install") === wrappedInstall)
          Object.defineProperty(patchedPlugin, "install", originalInstallDescriptor);
      } catch {}
      removeHideListener();
      if (pageCallHook?.dispose === dispose) pageCallHook = null;
    };
    const wrapped = function(...args) {
      const result = pageApply(original, this, args);
      if (disposed || patchedPlugin || probing) return result;
      probing = true;
      try {
        // A webpack factory must receive its own exports as thisArg and as
        // module.exports before an own export getter may be evaluated.
        if (args.length < 2 || !args[0] || pageOwnValue(args[1], "exports") !== args[0]) return result;
        const exported = Object.getOwnPropertyDescriptor(args[0], "a");
        if (!exported) return result;
        const plugin = Object.prototype.hasOwnProperty.call(exported, "value") ? exported.value
          : typeof exported.get === "function" ? pageApply(exported.get, args[0], []) : undefined;
        if (pageOwnValue(plugin, "version") !== "2.5.0") return result;
        const descriptor = Object.getOwnPropertyDescriptor(plugin, "install");
        if (!descriptor || typeof descriptor.value !== "function" || (!descriptor.writable && !descriptor.configurable)) return result;
        const install = descriptor.value;
        const mixedFrameworks = new WeakSet();
        wrappedInstall = function(...installArgs) {
          try {
            const framework = installArgs[0];
            if (framework && (typeof framework === "object" || typeof framework === "function") && typeof framework.mixin === "function" && !mixedFrameworks.has(framework)) {
              mixedFrameworks.add(framework);
              framework.mixin({mounted() {
                try { if (this.$el && (typeof this.$el === "object" || typeof this.$el === "function")) this.$el.__Ivue__ = this; } catch {}
              }});
            }
          } catch {}
          return pageApply(install, this, installArgs);
        };
        Object.defineProperty(plugin, "install", {...descriptor, value: wrappedInstall});
        patchedPlugin = plugin;
        originalInstallDescriptor = descriptor;
        // The page-wide probe is needed only until the target module appears.
        restoreCall();
      } catch {} finally { probing = false; }
      return result;
    };
    try { prototype.call = wrapped; } catch { return pageNoop; }
    if (prototype.call !== wrapped) return pageNoop;
    pageCallHook = {dispose};
    removeHideListener = pageDisposeOnHide(dispose);
    return dispose;
  };
