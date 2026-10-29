  // Direct manipulation stays outside the reactive render loop. Position and
  // viewport-dependent CSS are committed once, after the pointer is released.
  const createPanelInteractions = ({element, initialPosition, onCommit, onBeforeDrag = () => {}, onDragState = () => {}}) => {
    const view = window;
    const document2 = document;
    const requestFrame = typeof view.requestAnimationFrame === "function"
      ? callback => view.requestAnimationFrame(callback) : callback => view.setTimeout(callback, 16);
    const cancelFrame = typeof view.cancelAnimationFrame === "function"
      ? id => view.cancelAnimationFrame(id) : id => view.clearTimeout(id);
    let active = null, frame = null, disposed = false;
    const number = value => Number.isFinite(Number.parseFloat(value)) ? Number.parseFloat(value) : 0;
    const bounded = (x, y) => {
      const width = Math.min(396, Math.max(0, view.innerWidth - 16));
      return {x: Math.min(Math.max(0, view.innerWidth - width - 8), Math.max(0, number(x))),
        y: Math.min(Math.max(0, view.innerHeight - 88), Math.max(0, number(y)))};
    };
    const removeListeners = () => {
      document2.removeEventListener("mousemove", moveMouse);
      document2.removeEventListener("mouseup", endMouse);
      document2.removeEventListener("pointermove", movePointer);
      document2.removeEventListener("pointerup", endPointer);
      document2.removeEventListener("pointercancel", endPointer);
    };
    const paint = () => {
      frame = null;
      if (!active || disposed) return;
      const {node, x, y, originX, originY, transform} = active;
      node.style.transform = `translate3d(${x - originX}px,${y - originY}px,0)` + (transform && transform !== "none" ? " " + transform : "");
    };
    const move = event => {
      if (!active || disposed) return;
      const next = bounded(active.originX + number(event.clientX) - active.pointerX, active.originY + number(event.clientY) - active.pointerY);
      active.x = next.x; active.y = next.y;
      if (frame === null) frame = requestFrame(paint);
      if (event.cancelable) event.preventDefault();
    };
    const moveMouse = event => {if (active?.mode === "mouse") move(event);};
    const movePointer = event => {if (active?.mode === "pointer" && event.pointerId === active.pointerId) move(event);};
    const endMouse = () => {if (active?.mode === "mouse") endDrag();};
    const endPointer = event => {if (active?.mode === "pointer" && event.pointerId === active.pointerId) endDrag();};
    const lostCapture = event => {if (active?.mode === "pointer" && event.pointerId === active.pointerId) endDrag();};
    const shieldFor = node => {
      const tree = node.getRootNode();
      const root = tree?.nodeType === 9 ? tree.documentElement : tree;
      if (!root?.appendChild) return null;
      const shield = document2.createElement("div");
      shield.className = "ai-drag-shield";
      shield.setAttribute("aria-hidden", "true");
      shield.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:transparent;cursor:grabbing;touch-action:none;user-select:none";
      root.appendChild(shield);
      return shield;
    };
    const endDrag = () => {
      if (!active) return;
      const ending = active;
      active = null;
      if (frame !== null) cancelFrame(frame);
      frame = null;
      removeListeners();
      ending.capture?.removeEventListener?.("lostpointercapture", lostCapture);
      const next = bounded(ending.x, ending.y);
      const left = `${next.x}px`, top = `${next.y}px`;
      // Commit the final pending point synchronously, before removing the
      // compositor offset. Waiting for Vue here would paint the old position.
      ending.node.style.left = left;
      ending.node.style.top = top;
      ending.node.style.transform = ending.transform;
      ending.node.style.willChange = ending.willChange;
      ending.node.style.userSelect = ending.userSelect;
      if (ending.card) ending.card.style.height = ending.cardHeight;
      ending.node.removeAttribute("data-ai-dragging");
      ending.shield?.remove();
      try {
        if (ending.capture?.hasPointerCapture?.(ending.pointerId)) ending.capture.releasePointerCapture(ending.pointerId);
      } catch { /* A detached pointer target may have released it already. */ }
      onDragState(false);
      onCommit(left, top);
    };
    const start = (event, mode) => {
      if (disposed || active || event.button !== undefined && event.button !== 0 || event.isPrimary === false) return false;
      if (mode === "pointer" && !Number.isFinite(event.pointerId)) return false;
      if (event.target?.closest?.("button,input,textarea,select,a,[contenteditable=true]")) return false;
      const node = element();
      if (!node?.isConnected || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
      // Finish any size transition before measuring and locking the drag box.
      onBeforeDrag();
      const rect = node.getBoundingClientRect();
      const capture = event.currentTarget;
      const card = node.querySelector?.(".el-card");
      const cardHeight = card?.style.height || "";
      const cardSize = card ? card.getBoundingClientRect().height : 0;
      active = {node, mode, pointerId: event.pointerId, capture,
        pointerX: event.clientX, pointerY: event.clientY, originX: rect.left, originY: rect.top,
        x: rect.left, y: rect.top, transform: node.style.transform || "", willChange: node.style.willChange || "",
        userSelect: node.style.userSelect || "", card, cardHeight, shield: null};
      node.style.willChange = "transform";
      node.style.userSelect = "none";
      if (cardSize > 0) card.style.height = `${cardSize}px`;
      node.setAttribute("data-ai-dragging", "true");
      active.shield = shieldFor(node);
      if (mode === "pointer") {
        document2.addEventListener("pointermove", movePointer, {passive: false});
        document2.addEventListener("pointerup", endPointer);
        document2.addEventListener("pointercancel", endPointer);
        capture?.addEventListener?.("lostpointercapture", lostCapture);
        try {capture?.setPointerCapture?.(event.pointerId);} catch { /* The full-screen shield also covers the mouse fallback. */ }
      } else {
        document2.addEventListener("mousemove", moveMouse, {passive: false});
        document2.addEventListener("mouseup", endMouse);
      }
      if (event.cancelable) event.preventDefault();
      onDragState(true);
      return true;
    };
    const fit = () => {
      if (disposed) return;
      if (active) {endDrag(); return;}
      const position = initialPosition();
      const next = bounded(position?.x, position?.y);
      const left = `${next.x}px`, top = `${next.y}px`;
      const node = element();
      if (node) {node.style.left = left; node.style.top = top;}
      onCommit(left, top);
    };
    const hide = () => endDrag();
    view.addEventListener("resize", fit);
    view.addEventListener("blur", hide);
    view.addEventListener("pagehide", hide);
    return {fit,
      startPointerDrag: event => start(event, "pointer"),
      startMouseDrag: event => start(event, "mouse"),
      endDrag,
      dispose() {
        if (disposed) return;
        endDrag();
        disposed = true;
        view.removeEventListener("resize", fit);
        view.removeEventListener("blur", hide);
        view.removeEventListener("pagehide", hide);
      }
    };
  };
