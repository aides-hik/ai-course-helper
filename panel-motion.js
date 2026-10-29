  // Short, interruptible compositor animations. State/focus never wait for them.
  const createPanelMotion = ({element, nextTick, isMounted = () => true}) => {
    let active = null, epoch = 0, disposed = false;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const restore = (record) => {
      record.target.style.willChange = record.willChange;
      if (record.root.dataset) delete record.root.dataset.aiMotion;
    };
    const cancel = () => {
      ++epoch;
      const previous = active;
      active = null;
      if (previous) {previous.animation.cancel(); restore(previous);}
    };
    const reveal = async (selector, {offset = -4, duration = 160, axis = "Y"} = {}) => {
      const requested = ++epoch;
      await nextTick();
      if (disposed || requested !== epoch || !isMounted()) return;
      const root = element();
      const target = root?.querySelector(selector);
      if (!target || typeof target.animate !== "function" || document.visibilityState === "hidden" || root.dataset?.aiDragging === "true") {cancel(); return;}
      const reduced = !!media?.matches;
      // Only an interrupted animation on this same target needs a style sample.
      const current = active?.target === target ? getComputedStyle(target) : null;
      const initial = current ? {opacity: current.opacity, ...(reduced ? {} : {transform: current.transform})}
        : {opacity: .8, ...(reduced ? {} : {transform: axis === "X" ? `translate3d(${offset}px,0,0)` : `translate3d(0,${offset}px,0)`})};
      const final = {opacity: 1, ...(reduced ? {} : {transform: "none"})};
      const old = active;
      active = null;
      if (old) {old.animation.cancel(); restore(old);}
      const willChange = target.style.willChange;
      target.style.willChange = reduced ? "opacity" : "transform, opacity";
      root.dataset.aiMotion = "true";
      try {
        const animation = target.animate([initial, final], {
          duration: reduced ? 80 : Math.min(220, Math.max(80, duration)), easing: "cubic-bezier(0.22, 1, 0.36, 1)"
        });
        const record = {root, target, animation, willChange};
        active = record;
        const finished = () => {if (active === record) {active = null; restore(record);}};
        animation.onfinish = finished;
        animation.oncancel = finished;
      } catch {
        target.style.willChange = willChange;
        delete root.dataset.aiMotion;
      }
    };
    const hidden = () => {if (document.visibilityState === "hidden") cancel();};
    document.addEventListener("visibilitychange", hidden);
    media?.addEventListener?.("change", cancel);
    return {reveal, cancel, dispose() {
      if (disposed) return;
      disposed = true; cancel();
      document.removeEventListener("visibilitychange", hidden);
      media?.removeEventListener?.("change", cancel);
    }};
  };
