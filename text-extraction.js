  function extractRawTextFromElement(element, images, label = "题干", excludedElement) {
    if (!element)
      return "";
    const visit = (node) => {
      if (node === excludedElement) return "";
      if (node.nodeType === 3 || node.nodeType === 4)
        return node.nodeValue || "";
      if (node.nodeType === 11) {
        return Array.from(node.childNodes).map(visit).join("");
      }
      if (node.nodeType !== 1)
        return "";
      const current = node;
      const tag = current.tagName.toLowerCase();
      // Retain a non-HTML marker when text cannot describe a real visual node.
      // Literal text such as "<svg>" remains text because it is a text node.
      if (["svg", "canvas", "video", "audio", "object", "embed", "iframe", "math"].includes(tag))
        return `\uFFFC[ai-visual:${tag}]\uFFFC`;
      let background = "";
      try {
        const style = current.ownerDocument?.defaultView?.getComputedStyle?.(current);
        if (/url\s*\(/i.test(style?.backgroundImage || ""))
          background = "\uFFFC[ai-visual:background]\uFFFC";
      } catch { /* Inaccessible styles cannot add image content. */ }
      if (tag === "img") {
        if (Array.isArray(images)) {
          const marker = `\uFFFC[ai-image:${images.length}]\uFFFC`;
          images.push({marker, label, element: current});
          return background + marker;
        }
        const src = current.getAttribute("src");
        return background + (src == null ? "<img>" : `<img src="${src}">`);
      }
      if (tag === "br")
        return background + "\n";
      if (tag === "sup")
        return background + `^(${Array.from(current.childNodes).map(visit).join("")})`;
      if (tag === "sub")
        return background + `_(${Array.from(current.childNodes).map(visit).join("")})`;
      return background + Array.from(current.childNodes).map(visit).join("");
    };
    return visit(element);
  }
  function extractRawTextFromHtml(html, ownerDocument, images, label) {
    if (html == null || html === "")
      return "";
    const documentRef = ownerDocument || (typeof document !== "undefined" ? document : null);
    if (!documentRef)
      return html;
    const container = documentRef.createElement("div");
    container.innerHTML = html;
    return extractRawTextFromElement(container, images, label);
  }
