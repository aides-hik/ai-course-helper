  // Keep one normalized optical map for the lifetime of the panel. Geometry
  // changes stretch this map; they never reload a filter image mid-transition.
  let liquidGlassSequence = 0;
  const attachLiquidGlass = (mountNode) => {
    const noop = () => {};
    const root = mountNode?.getRootNode?.();
    const safariOnly = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent);
    if (safariOnly || !CSS.supports("backdrop-filter", "url(#lg)") || !root?.appendChild) return noop;
    const preference = window.matchMedia?.("(prefers-reduced-transparency: reduce)");
    const filterId = "course-helper-glass-" + ++liquidGlassSequence;
    const filterValue = "url(#" + filterId + ") blur(1px) saturate(1.1)";
    let surface = null, panel = null, svg = null, feImage = null;
    let presence = null, state = null, timer = null, idle = null, frame = null;
    let mapData = null, decodedImage = null, decoded = false, decoding = false, mapReady = false;
    let failed = false, disposed = false, suspended = false;
    const blocked = () => disposed || suspended || document.hidden || preference?.matches ||
      panel?.getAttribute("data-ai-dragging") === "true" || panel?.getAttribute("data-ai-motion") === "true";
    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      if (idle !== null) window.cancelIdleCallback?.(idle);
      if (frame !== null) window.cancelAnimationFrame(frame);
      timer = idle = frame = null;
    };
    const removeFilter = () => {
      surface?.style.removeProperty("--ai-glass-edge-filter");
      svg?.remove(); svg = feImage = null; mapReady = false;
    };
    const attach = () => {
      if (!mapReady || blocked() || !surface?.isConnected) return;
      if (surface.style.getPropertyValue("--ai-glass-edge-filter") !== filterValue)
        surface.style.setProperty("--ai-glass-edge-filter", filterValue);
    };
    const map = () => {
      if (mapData) return mapData;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 384;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Glass canvas unavailable");
      const horizontal = context.createLinearGradient(0, 0, 384, 0);
      horizontal.addColorStop(0, "rgb(0,0,0)"); horizontal.addColorStop(1, "rgb(255,0,0)");
      context.fillStyle = horizontal; context.fillRect(0, 0, 384, 384);
      const vertical = context.createLinearGradient(0, 0, 0, 384);
      vertical.addColorStop(0, "rgb(0,0,0)"); vertical.addColorStop(1, "rgb(0,0,255)");
      context.globalCompositeOperation = "difference"; context.fillStyle = vertical; context.fillRect(0, 0, 384, 384);
      context.globalCompositeOperation = "source-over";
      context.filter = "blur(7px)"; context.fillStyle = "rgba(128,128,128,0.94)"; context.beginPath();
      if (typeof context.roundRect === "function") context.roundRect(30, 30, 324, 324, 12);
      else context.rect(30, 30, 324, 324);
      context.fill(); mapData = canvas.toDataURL(); return mapData;
    };
    const warm = () => {
      if (blocked() || !svg || mapReady || frame !== null) return;
      // decode() has primed the shared image cache. Give the new SVG resource
      // two render opportunities before making it visible through CSS.
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (blocked() || !svg) return;
        frame = window.requestAnimationFrame(() => {
          frame = null;
          if (blocked() || !svg) return;
          mapReady = true; attach();
        });
      });
    };
    const prepare = async () => {
      if (blocked() || failed || decoding || !surface?.isConnected) return;
      if (svg) {warm(); attach(); return;}
      decoding = true;
      try {
        const data = map();
        if (!decoded) {
          const image = decodedImage = new window.Image();
          image.src = data;
          await image.decode();
          if (disposed || decodedImage !== image) return;
          decoded = true;
        }
        if (blocked() || !surface?.isConnected) return;
        const create = name => document.createElementNS("http://www.w3.org/2000/svg", name);
        svg = create("svg"); svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
        svg.setAttribute("aria-hidden", "true"); svg.style.cssText = "position:absolute;width:0;height:0;pointer-events:none";
        const defs = create("defs"), effect = create("filter"), displaced = create("feDisplacementMap");
        effect.id = filterId; effect.setAttribute("color-interpolation-filters", "sRGB");
        effect.setAttribute("filterUnits", "objectBoundingBox");
        effect.setAttribute("x", "0"); effect.setAttribute("y", "0");
        effect.setAttribute("width", "100%"); effect.setAttribute("height", "100%");
        const image = feImage = create("feImage");
        image.setAttribute("result", "map"); image.setAttribute("preserveAspectRatio", "none");
        image.setAttribute("x", "0"); image.setAttribute("y", "0");
        image.setAttribute("width", "100%"); image.setAttribute("height", "100%");
        displaced.setAttribute("in", "SourceGraphic"); displaced.setAttribute("in2", "map");
        displaced.setAttribute("scale", "-34"); displaced.setAttribute("xChannelSelector", "R"); displaced.setAttribute("yChannelSelector", "B");
        effect.append(image, displaced); defs.appendChild(effect); svg.appendChild(defs); root.appendChild(svg);
        image.setAttribute("href", data);
        warm();
      } catch {if (!disposed) {failed = true; removeFilter();}}
      finally {decoding = false;}
    };
    const schedule = () => {
      cancel();
      if (blocked() || failed) return;
      if (mapReady) {attach(); return;}
      if (svg) {warm(); return;}
      if (decoding) return;
      timer = setTimeout(() => {
        timer = null;
        if (blocked()) return;
        if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(() => {idle = null; prepare();}, {timeout: 500});
        else prepare();
      }, 120);
    };
    const syncState = () => {if (blocked()) cancel(); else schedule();};
    const find = (force = false) => {
      if (disposed || suspended) return;
      const found = mountNode.querySelector(".ai-glass-surface") || mountNode.querySelector(".el-card");
      if (!force && found === surface && surface?.isConnected) return;
      if (found !== surface) surface?.style.removeProperty("--ai-glass-edge-filter");
      surface = found; panel = surface?.closest?.(".main-page") || null;
      state?.disconnect(); presence?.disconnect();
      if (!presence && typeof MutationObserver === "function") presence = new MutationObserver(() => find());
      if (presence) {
        const parents = new Set([mountNode, panel, panel?.parentElement, surface?.parentElement].filter(Boolean));
        for (const parent of parents) presence.observe(parent, {childList: true, subtree: !surface});
      }
      if (panel && typeof MutationObserver === "function") {
        if (!state) state = new MutationObserver(syncState);
        state.observe(panel, {attributes: true, attributeFilter: ["data-ai-dragging", "data-ai-motion", "hidden"]});
      }
      schedule();
    };
    const pause = () => {suspended = true; cancel(); state?.disconnect(); presence?.disconnect();};
    const resume = () => {if (!disposed) {suspended = false; find(true);}};
    const visibility = () => {if (document.hidden) pause(); else resume();};
    // Preserve a prepared graph while CSS removes its reduced-transparency
    // consumer. Restoring the preference must not reload the optical image.
    const preferenceChanged = () => {if (preference?.matches) cancel(); else schedule();};
    const hide = event => {if (event.persisted) pause(); else dispose();};
    const show = event => {if (event.persisted) resume();};
    const dispose = () => {
      if (disposed) return;
      disposed = true; pause(); removeFilter(); mapData = decodedImage = null; surface = panel = null;
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
