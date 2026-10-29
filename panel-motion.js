  // A single clipped body owns the changing geometry. Its absolute glass
  // sibling follows that box, keeping the shell and content on the same clock.
  const createPanelMotion = ({element, nextTick, isMounted = () => true}) => {
    let active = null, epoch = 0, disposed = false;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const clear = () => {
      const record = active;
      active = null;
      if (!record) return;
      for (const animation of record.animations) animation.cancel();
      for (const [node, styles] of record.styles) Object.assign(node.style, styles);
      if (record.root.dataset) delete record.root.dataset.aiMotion;
    };
    const cancel = () => {++epoch; clear();};
    const height = node => node?.getBoundingClientRect?.().height || 0;
    const run = async (selector, {offset = -4, duration = 160, axis = "Y", resize = false} = {}) => {
      const requested = ++epoch;
      const previousRoot = element();
      const previousTarget = previousRoot?.querySelector(selector);
      const sampled = active?.target === previousTarget ? getComputedStyle(previousTarget) : null;
      const current = sampled ? {opacity: sampled.opacity, transform: sampled.transform} : null;
      // Capture the *visible* geometry before Vue changes vShow or the tab.
      const before = resize ? height(previousRoot?.querySelector(".el-card__body")) : 0;
      clear();
      await nextTick();
      if (disposed || requested !== epoch || !isMounted()) return;
      const root = element();
      const target = root?.querySelector(selector);
      if (!target || typeof target.animate !== "function" || document.visibilityState === "hidden" || root.dataset?.aiDragging === "true") {cancel(); return;}
      const reduced = !!media?.matches;
      const initial = current ? {opacity: current.opacity, ...(reduced ? {} : {transform: current.transform})}
        : {opacity: .8, ...(reduced ? {} : {transform: axis === "X" ? `translate3d(${offset}px,0,0)` : `translate3d(0,${offset}px,0)`})};
      const final = {opacity: 1, ...(reduced ? {} : {transform: "none"})};
      const record = {root, target, animations: [], styles: new Map(), pending: 0};
      const patch = (node, styles) => {
        if (!record.styles.has(node)) record.styles.set(node, {});
        const saved = record.styles.get(node);
        for (const key of Object.keys(styles)) if (!(key in saved)) saved[key] = node.style[key] || "";
        Object.assign(node.style, styles);
      };
      const timing = {duration: reduced ? 80 : Math.min(260, Math.max(80, duration)), easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both"};
      const animate = (node, frames, willChange = "transform") => {
        patch(node, {willChange});
        const animation = node.animate(frames, timing);
        record.animations.push(animation);
        ++record.pending;
        animation.onfinish = () => {if (active === record && --record.pending === 0) clear();};
        animation.oncancel = () => {if (active === record) cancel();};
      };
      active = record;
      root.dataset.aiMotion = "true";
      try {
        if (resize && !reduced) {
          const body = root.querySelector(".el-card__body"), endHeight = height(body);
          if (body && before && endHeight && Math.abs(before - endHeight) >= .5) {
            // A deliberate card resize: only this bounded viewport changes
            // height. No scaled text, corners, shadow or independent shell tick.
            patch(body, {overflow: "hidden"});
            animate(body, [{height: `${before}px`}, {height: `${endHeight}px`}], "height");
          }
        }
        animate(target, [initial, final], reduced ? "opacity" : "transform, opacity");
      } catch {cancel();}
    };
    const hidden = () => {if (document.visibilityState === "hidden") cancel();};
    document.addEventListener("visibilitychange", hidden);
    media?.addEventListener?.("change", cancel);
    return {reveal: (selector, options) => run(selector, options), resize: (selector, options) => run(selector, {...options, resize: true}), cancel, dispose() {
      if (disposed) return;
      disposed = true; cancel();
      document.removeEventListener("visibilitychange", hidden);
      media?.removeEventListener?.("change", cancel);
    }};
  };
