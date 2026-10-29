  // The shell keeps CSS glass continuously. This optional, single-pass rim is
  // prepared only while idle, and never follows pointer or animation frames.
  let liquidGlassSequence = 0;
  const attachLiquidGlass = (mountNode) => {
    const noop = () => {};
    const root = mountNode?.getRootNode?.();
    const safariOnly = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent);
    if (safariOnly || !CSS.supports("backdrop-filter", "url(#lg)") || !root?.appendChild) return noop;
    const preference = window.matchMedia?.("(prefers-reduced-transparency: reduce)");
    const filterId = "course-helper-glass-" + ++liquidGlassSequence;
    const maps = new Map();
    let card = null, panel = null, svg = null, feImage = null;
    let resize = null, presence = null, state = null;
    let timer = null, idle = null, lastSize = "";
    let disposed = false, suspended = false;
    const blocked = () => disposed || suspended || document.hidden || preference?.matches ||
      panel?.getAttribute("data-ai-dragging") === "true" || panel?.getAttribute("data-ai-motion") === "true";
    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      if (idle !== null) window.cancelIdleCallback?.(idle);
      timer = idle = null;
    };
    const removeFilter = () => {
      card?.style.removeProperty("--ai-glass-edge-filter");
      svg?.remove(); svg = feImage = null; lastSize = "";
    };
    const filter = () => {
      if (svg) return;
      const create = name => document.createElementNS("http://www.w3.org/2000/svg", name);
      svg = create("svg"); svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
      svg.setAttribute("aria-hidden", "true"); svg.style.cssText = "position:absolute;width:0;height:0;pointer-events:none";
      const defs = create("defs"), effect = create("filter"), displaced = create("feDisplacementMap");
      effect.id = filterId; effect.setAttribute("color-interpolation-filters", "sRGB");
      effect.setAttribute("x", "0"); effect.setAttribute("y", "0");
      effect.setAttribute("width", "100%"); effect.setAttribute("height", "100%");
      feImage = create("feImage"); feImage.setAttribute("result", "map"); feImage.setAttribute("preserveAspectRatio", "none");
      displaced.setAttribute("in", "SourceGraphic"); displaced.setAttribute("in2", "map");
      displaced.setAttribute("scale", "-34"); displaced.setAttribute("xChannelSelector", "R"); displaced.setAttribute("yChannelSelector", "B");
      effect.append(feImage, displaced); defs.appendChild(effect); svg.appendChild(defs); root.appendChild(svg);
    };
    const mapFor = (width, height, radius, key) => {
      if (maps.has(key)) {const value = maps.get(key); maps.delete(key); maps.set(key, value); return value;}
      const scale = Math.min(1, 384 / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Glass canvas unavailable");
      const horizontal = context.createLinearGradient(0, 0, canvas.width, 0);
      horizontal.addColorStop(0, "rgb(0,0,0)"); horizontal.addColorStop(1, "rgb(255,0,0)");
      context.fillStyle = horizontal; context.fillRect(0, 0, canvas.width, canvas.height);
      const vertical = context.createLinearGradient(0, 0, 0, canvas.height);
      vertical.addColorStop(0, "rgb(0,0,0)"); vertical.addColorStop(1, "rgb(0,0,255)");
      context.globalCompositeOperation = "difference"; context.fillStyle = vertical; context.fillRect(0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = "source-over";
      const inset = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) * 0.08));
      context.filter = "blur(7px)"; context.fillStyle = "rgba(128,128,128,0.94)"; context.beginPath();
      const corner = Math.max(radius * scale - inset, 2);
      if (typeof context.roundRect === "function") context.roundRect(inset, inset, canvas.width - inset * 2, canvas.height - inset * 2, corner);
      else context.rect(inset, inset, canvas.width - inset * 2, canvas.height - inset * 2);
      context.fill();
      const value = canvas.toDataURL(); maps.set(key, value);
      if (maps.size > 4) maps.delete(maps.keys().next().value);
      return value;
    };
    const apply = () => {
      if (blocked() || !card?.isConnected) return;
      const width = Math.round(card.offsetWidth), height = Math.round(card.offsetHeight);
      if (width < 40 || height < 40) return;
      const radius = parseFloat(getComputedStyle(card).borderTopLeftRadius) || 26;
      const key = width + ":" + height + ":" + radius;
      if (key === lastSize) return;
      try {
        const map = mapFor(width, height, radius, key);
        filter(); feImage.setAttribute("href", map); feImage.setAttribute("width", String(width)); feImage.setAttribute("height", String(height));
        card.style.setProperty("--ai-glass-edge-filter", "url(#" + filterId + ") blur(1px) saturate(1.1)");
        lastSize = key;
      } catch {removeFilter();}
    };
    const schedule = () => {
      cancel();
      if (blocked()) return;
      timer = setTimeout(() => {
        timer = null;
        if (blocked()) return;
        if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(() => {idle = null; apply();}, {timeout: 500});
        else apply();
      }, 120);
    };
    const syncState = () => {
      if (blocked()) cancel(); else schedule();
    };
    const find = () => {
      if (disposed || suspended) return;
      const found = mountNode.querySelector(".el-card");
      if (found === card && card?.isConnected) return;
      card?.style.removeProperty("--ai-glass-edge-filter");
      card = found; panel = card?.closest?.(".main-page") || null; lastSize = "";
      resize?.disconnect(); state?.disconnect(); presence?.disconnect();
      if (!presence && typeof MutationObserver === "function") presence = new MutationObserver(find);
      if (presence) {
        const parents = new Set([mountNode, panel?.parentElement, card?.parentElement].filter(Boolean));
        for (const parent of parents) presence.observe(parent, {childList: true, subtree: !card});
      }
      if (card && typeof ResizeObserver === "function") {
        if (!resize) resize = new ResizeObserver(schedule);
        resize.observe(card);
      }
      if (panel && typeof MutationObserver === "function") {
        if (!state) state = new MutationObserver(syncState);
        // Do not observe style: dragging updates transform on this element.
        state.observe(panel, {attributes: true, attributeFilter: ["data-ai-dragging", "data-ai-motion", "hidden"]});
      }
      schedule();
    };
    const pause = () => {suspended = true; cancel(); resize?.disconnect(); state?.disconnect(); presence?.disconnect();};
    const resume = () => {
      if (disposed) return;
      suspended = false;
      // Force a fresh binding; an element may have been replaced while hidden.
      card?.style.removeProperty("--ai-glass-edge-filter"); card = panel = null; lastSize = ""; find();
    };
    const visibility = () => {if (document.hidden) pause(); else resume();};
    const preferenceChanged = () => {if (preference?.matches) {cancel(); removeFilter();} else schedule();};
    const hide = event => {if (event.persisted) pause(); else dispose();};
    const show = event => {if (event.persisted) resume();};
    const dispose = () => {
      if (disposed) return;
      disposed = true; pause(); removeFilter(); maps.clear(); card = panel = null;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show);
      preference?.removeEventListener?.("change", preferenceChanged);
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", hide); window.addEventListener("pageshow", show);
    preference?.addEventListener?.("change", preferenceChanged);
    find();
    if (document.hidden) pause();
    return dispose;
  };
