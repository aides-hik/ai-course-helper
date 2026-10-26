  // Images are collected from the same DOM traversal that writes their markers.
  // No GM/network grants are added. Detached public-image loads use anonymous
  // CORS; webpage cookies are never forwarded to the model service.
  const AI_IMAGE_LIMITS = Object.freeze({count: 20, bytes: 8 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, pixels: 40 * 1024 * 1024});
  const aiImageCurrent = (context = {}) => {
    try { return !context.signal?.aborted && (context.isCurrent?.() ?? true); }
    catch { return false; }
  };
  const aiImageError = (message) => ({error: message});
  const AI_IMAGE_OPTION_CONTENT = ".node_detail,.fl.after,.answer_p";
  const AI_IMAGE_OPTION_ROWS = '.answerBg,[class*="before-after"],.label,.ans-videoquiz-opt';
  const aiImageSelectionDecoration = (element) => {
    const decoration = element.closest?.(".before,.ans-videoquiz-opt-label");
    if (!decoration || decoration.closest?.(AI_IMAGE_OPTION_CONTENT)) return false;
    const row = decoration.closest?.(AI_IMAGE_OPTION_ROWS);
    return !!row && row !== decoration && !!row.querySelector?.(AI_IMAGE_OPTION_CONTENT) && !decoration.querySelector?.(AI_IMAGE_OPTION_CONTENT);
  };
  const aiQuestionHasUnsupportedVisual = (question) => {
    // Inspect content roots as well as the text span: option decorations can
    // carry a diagram outside the span that the platform uses for its label.
    const roots = new Set([
      ...Array.from(question?.element?.querySelectorAll?.("h3,.fontLabel,.subject_describe,.smallStem_describe,.tkItem_title,.ans-videoquiz-title") || []),
      ...Object.values(question?.options || {})
    ]);
    for (const image of question?.searchText?.images || []) {
      const row = image?.element?.closest?.('.answerBg,[class*="before-after"],.label,.ans-videoquiz-opt');
      if (row) roots.add(row);
    }
    const visit = (element, visited = new Set()) => {
      if (!element || visited.has(element)) return false;
      visited.add(element);
      const tag = String(element.tagName || "").toLowerCase();
      if (["input", "textarea", "select", "button", "script", "style"].includes(tag) || element.getAttribute?.("contenteditable") === "true") return false;
      if (aiImageSelectionDecoration(element)) return false;
      if (["svg", "canvas", "video", "audio", "object", "embed", "iframe", "math"].includes(tag)) return true;
      // A platform paints selection indicators on the option wrapper. Its actual
      // content span is still inspected, as are unsupported sibling diagrams.
      const optionWrapper = element.matches?.(AI_IMAGE_OPTION_ROWS) && !element.matches?.(AI_IMAGE_OPTION_CONTENT) && element.querySelector?.(AI_IMAGE_OPTION_CONTENT);
      const background = optionWrapper ? "" : element.style?.backgroundImage || element.ownerDocument?.defaultView?.getComputedStyle?.(element)?.backgroundImage;
      if (typeof background === "string" && /url\s*\(/i.test(background)) return true;
      const shadow = element.__Ivue__?._data?.shadowDom;
      return [...Array.from(element.children || []), element.shadowRoot, typeof shadow === "object" ? shadow : null]
        .filter(Boolean).some((child) => visit(child, visited));
    };
    return [...roots].some((root) => visit(root));
  };
  const aiQuestionImageDescriptors = (question) => {
    try {
      const search = question?.searchText;
      const explicit = search && Object.prototype.hasOwnProperty.call(search, "images");
      const images = explicit ? search.images : [];
      if (!Array.isArray(images)) return aiImageError("题目图片信息不完整，请刷新页面后重试");
      if (images.length > AI_IMAGE_LIMITS.count) return aiImageError(`每题最多支持 ${AI_IMAGE_LIMITS.count} 张图片，请手动处理此题`);
      if (aiQuestionHasUnsupportedVisual(question)) return aiImageError("题目包含 SVG、canvas、背景图片或其他暂不支持的视觉内容，请手动处理此题");
      const texts = [search?.stem ?? question?.title ?? "", ...(Array.isArray(search?.options) ? search.options : question?.optionsText || [])];
      if (texts.some((text) => typeof text !== "string")) return aiImageError("题目图片位置无法确认，请手动处理");
      if (texts.some((text) => /\uFFFC\[ai-visual:[a-z]+\]\uFFFC/i.test(text))) return aiImageError("暂不支持 SVG、canvas 或其他非图片视觉内容，请手动处理此题");
      const markers = texts.flatMap((text) => text.match(/\uFFFC\[ai-image:[^\]]*\]\uFFFC/g) || []);
      if (markers.length !== images.length || new Set(markers).size !== images.length) return aiImageError("题目图片与位置标记不一致，请刷新页面后重试");
      for (const [index, descriptor] of images.entries()) {
        if (!descriptor || descriptor.marker !== `\uFFFC[ai-image:${index}]\uFFFC` || !markers.includes(descriptor.marker) || String(descriptor.element?.tagName).toLowerCase() !== "img") return aiImageError("题目图片与位置标记不一致，请刷新页面后重试");
      }
      // A legacy parser must not silently send a real image as plain text. Text
      // literals such as "<img>" are permitted by the explicit DOM contract.
      if (!explicit && texts.some((text) => /<img\b/i.test(text))) return aiImageError("图片尚未完整提取，请刷新页面后重试");
      const actualImages = Array.from(question?.element?.querySelectorAll?.("img") || []).filter((element) => String(element.tagName).toLowerCase() === "img" && !element.closest?.('[contenteditable="true"]') && !aiImageSelectionDecoration(element));
      if (actualImages.length > images.length) return aiImageError("题目中有尚未完整提取的图片，请手动处理此题");
      return {images: images.map((descriptor) => ({marker: descriptor.marker, label: typeof descriptor.label === "string" ? descriptor.label.slice(0, 80) : "", element: descriptor.element}))};
    } catch { return aiImageError("题目图片解析失败，请手动处理此题"); }
  };
  const aiImageDataUrl = (source) => {
    if (typeof source !== "string") return aiImageError("图片数据格式不正确");
    // Check length before a regular expression scans a potentially large string.
    if (source.length > Math.ceil(AI_IMAGE_LIMITS.bytes / 3) * 4 + 64) return aiImageError("单张图片超过 8 MiB，请手动处理此题");
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(source);
    if (!match || match[2].length % 4 !== 0) return aiImageError("仅支持有效的 PNG、JPEG、WebP 或 GIF 图片数据");
    const encoded = match[2], alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if ((encoded.endsWith("==") && (alphabet.indexOf(encoded.at(-3)) & 15)) || (encoded.endsWith("=") && !encoded.endsWith("==") && (alphabet.indexOf(encoded.at(-2)) & 3))) return aiImageError("图片数据编码不正确");
    const bytes = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    if (bytes > AI_IMAGE_LIMITS.bytes) return aiImageError("单张图片超过 8 MiB，请手动处理此题");
    const header = [];
    for (let index = 0; index < Math.min(24, encoded.length); index += 4) {
      const values = encoded.slice(index, index + 4).split("").map((char) => alphabet.indexOf(char));
      header.push((values[0] << 2) | (values[1] >> 4));
      if (values[2] >= 0) header.push(((values[1] & 15) << 4) | (values[2] >> 2));
      if (values[3] >= 0) header.push(((values[2] & 3) << 6) | values[3]);
    }
    const equal = (offset, expected) => expected.every((value, index) => header[offset + index] === value);
    const mime = match[1].toLowerCase();
    const valid = mime === "png" ? equal(0, [137,80,78,71,13,10,26,10])
      : mime === "jpeg" ? equal(0, [255,216,255])
      : mime === "gif" ? equal(0, [71,73,70,56]) && [55,57].includes(header[4]) && header[5] === 97
      : equal(0, [82,73,70,70]) && equal(8, [87,69,66,80]);
    if (!valid) return aiImageError("图片格式与内容不一致，请手动处理此题");
    return {url: `data:image/${mime};base64,${encoded}`, bytes};
  };
  const aiImageSource = (element) => {
    const current = typeof element.currentSrc === "string" ? element.currentSrc.trim() : "";
    const src = element.getAttribute?.("src") || "";
    const lazy = ["data-src", "data-original", "data-lazy-src", "lazy-src"].map((name) => element.getAttribute?.(name)?.trim()).find(Boolean);
    // An actual responsive source wins. A lazy URL wins over a src placeholder.
    return current && (element.getAttribute?.("srcset") || element.parentElement?.tagName?.toLowerCase() === "picture") ? current : lazy || current || src || element.src || "";
  };
  const aiImagePublicUrl = (url) => {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || /\.(?:localhost|local)$/.test(host) || host === "::" || host === "::1" || /^(?:fc|fd|fe8|fe9|fea|feb)[0-9a-f:]*:/i.test(host)) return false;
    if (host.includes(":") && !/^[23][0-9a-f]*:/i.test(host)) return false;
    const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
    if (!ipv4) return true;
    const [first, second] = ipv4.slice(1).map(Number);
    return ![0,10,127].includes(first) && !(first === 169 && second === 254) && !(first === 172 && second >= 16 && second <= 31) && !(first === 192 && second === 168) && first < 224;
  };
  const aiImageLoadState = (image, context, deadline, timeout) => new Promise((resolve) => {
    let timer, settled = false;
    const until = Math.min(deadline, Date.now() + timeout);
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.removeEventListener?.("load", check);
      image.removeEventListener?.("error", failed);
      context.signal?.removeEventListener("abort", aborted);
      resolve(state);
    };
    const aborted = () => finish({error: "请求已取消"});
    const failed = () => finish({ready: false});
    const check = () => {
      if (!aiImageCurrent(context)) return aborted();
      if (Date.now() >= deadline) return finish({error: "题目图片加载超时，请确认图片完整显示后重试"});
      if (image.complete) return finish({ready: Number(image.naturalWidth) > 0 && Number(image.naturalHeight) > 0});
      if (Date.now() >= until) return finish({ready: false});
      if (typeof image.addEventListener !== "function") return finish({ready: false});
      clearTimeout(timer);
      timer = setTimeout(check, Math.min(250, until - Date.now()));
    };
    image.addEventListener?.("load", check);
    image.addEventListener?.("error", failed);
    context.signal?.addEventListener("abort", aborted, {once: true});
    check();
  });
  const aiImageBrowserConstructor = (question, element) => element.ownerDocument?.defaultView?.Image || question?.element?.ownerDocument?.defaultView?.Image || (typeof Image === "function" ? Image : null);
  const aiImageDecodeSource = async (source, question, element, context, deadline, anonymous = false) => {
    const ImageConstructor = aiImageBrowserConstructor(question, element);
    if (typeof ImageConstructor !== "function") return {unavailable: true};
    const decoded = new ImageConstructor();
    if (anonymous) decoded.crossOrigin = "anonymous";
    decoded.referrerPolicy = "no-referrer";
    if (!aiImageCurrent(context)) return aiImageError("请求已取消");
    decoded.src = source;
    const state = await aiImageLoadState(decoded, context, deadline, 5000);
    if (!state.ready) {
      decoded.removeAttribute?.("src");
      return state;
    }
    return {ready: true, element: decoded};
  };
  const aiImageEncodePixels = (image, documentRef, maxSide) => {
    const width = Number(image.naturalWidth), height = Number(image.naturalHeight);
    if (!(width > 0 && height > 0)) return {unreadable: true};
    if (width * height > AI_IMAGE_LIMITS.pixels) return aiImageError("图片尺寸过大，请手动处理此题");
    const ratio = Math.min(1, maxSide / Math.max(width, height));
    try {
      const canvas = documentRef.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      const drawing = canvas.getContext("2d");
      if (!drawing) return {unreadable: true};
      drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
      let data = aiImageDataUrl(canvas.toDataURL("image/png"));
      // Some noisy bitmaps exceed the byte limit as PNG. Preserve the entire
      // image and try a compressed encoding rather than crop away information.
      if (data.error && /8 MiB/.test(data.error)) {
        drawing.globalCompositeOperation = "destination-over";
        drawing.fillStyle = "#ffffff";
        drawing.fillRect(0, 0, canvas.width, canvas.height);
        drawing.globalCompositeOperation = "source-over";
        data = aiImageDataUrl(canvas.toDataURL("image/jpeg", 0.9));
      }
      return data;
    } catch { return {unreadable: true}; }
  };
  const aiCollectQuestionImages = async (question, context = {}) => {
    if (!aiImageCurrent(context)) return aiImageError("请求已取消");
    const descriptors = aiQuestionImageDescriptors(question);
    if (descriptors.error) return descriptors;
    const images = [];
    let totalBytes = 0;
    const deadline = Date.now() + 15000;
    const deepseek = context.provider === "deepseek";
    const maxSide = deepseek ? descriptors.images.length >= 15 ? 4096 : 8192 : Infinity;
    for (const descriptor of descriptors.images) {
      if (!aiImageCurrent(context)) return aiImageError("请求已取消");
      if (Date.now() >= deadline) return aiImageError("题目图片加载超时，请确认图片完整显示后重试");
      try {
        const element = descriptor.element;
        const raw = aiImageSource(element);
        if (typeof raw !== "string" || !raw.trim()) return aiImageError("有图片缺少可读取的地址，请手动处理此题");
        let source = raw.trim(), resolved, bytes = 0;
        const base = question?.element?.ownerDocument?.baseURI || element.ownerDocument?.baseURI;
        if (/^data:/i.test(source)) {
          const data = aiImageDataUrl(source);
          if (data.error) return data;
          const decoded = await aiImageDecodeSource(data.url, question, element, context, deadline);
          if (decoded.error) return decoded;
          if (!decoded.unavailable && !decoded.ready) return aiImageError("图片数据无法解码，请确认图片有效后重试");
          if (decoded.ready) {
            const width = Number(decoded.element.naturalWidth), height = Number(decoded.element.naturalHeight);
            if (width * height > AI_IMAGE_LIMITS.pixels) return aiImageError("图片尺寸过大，请手动处理此题");
            if (Math.max(width, height) > maxSide) {
              const resized = aiImageEncodePixels(decoded.element, element.ownerDocument || question.element.ownerDocument, maxSide);
              if (resized.error) return resized;
              if (resized.unreadable) return aiImageError("图片尺寸超过模型限制，且无法缩小，请手动处理此题");
              resolved = resized.url; bytes = resized.bytes;
            }
          }
          if (!resolved) {resolved = data.url; bytes = data.bytes;}
        } else {
          if (source.length > 8192) return aiImageError("图片地址过长，请手动处理此题");
          let url;
          try { url = new URL(source, base); } catch { return aiImageError("图片地址无法解析，请手动处理此题"); }
          const localBlob = url.protocol === "blob:";
          if (!["https:", "http:", "blob:"].includes(url.protocol) || /\.svgz?$/i.test(url.pathname)) return aiImageError("仅支持 HTTP、HTTPS 或可读取的图片数据；SVG 图片请手动处理");
          url.username = ""; url.password = ""; url.hash = "";
          // Drawing a cached image reuses the browser's loaded pixels, including
          // login-protected images, without sending webpage cookies to the API.
          let loadedSource = "";
          try { loadedSource = new URL(element.currentSrc || element.src || "", base).href; } catch {}
          let sourceMatches = loadedSource === new URL(source, base).href;
          if (sourceMatches && !element.complete && typeof element.addEventListener === "function") {
            const loaded = await aiImageLoadState(element, context, deadline, 3000);
            if (loaded.error) return loaded;
            try { loadedSource = new URL(element.currentSrc || element.src || "", base).href; } catch { loadedSource = ""; }
            sourceMatches = loadedSource === new URL(source, base).href;
          }
          const width = Number(element.naturalWidth), height = Number(element.naturalHeight);
          const browserImageAvailable = typeof aiImageBrowserConstructor(question, element) === "function";
          const originalFailed = browserImageAvailable && sourceMatches && element.complete === true && (!(width > 0) || !(height > 0));
          if (Number.isFinite(width) && Number.isFinite(height) && width * height > AI_IMAGE_LIMITS.pixels) return aiImageError("图片尺寸过大，请手动处理此题");
          if (element.complete && width > 0 && height > 0 && sourceMatches) {
            const data = aiImageEncodePixels(element, element.ownerDocument || question.element.ownerDocument, maxSide);
            if (data.error) return data;
            if (!data.unreadable) {resolved = data.url; bytes = data.bytes;}
          }
          if (!resolved && (localBlob || deepseek && aiImagePublicUrl(url))) {
            const decoded = await aiImageDecodeSource(url.href, question, element, context, deadline, !localBlob);
            if (decoded.error) return decoded;
            if (decoded.ready) {
              const data = aiImageEncodePixels(decoded.element, element.ownerDocument || question.element.ownerDocument, maxSide);
              if (data.error) return data;
              if (!data.unreadable) {resolved = data.url; bytes = data.bytes;}
            }
          }
          if (!resolved) {
            if (localBlob) return aiImageError("此图片的临时地址无法读取，请加载图片后重试或手动处理");
            if (originalFailed) return aiImageError("图片未能加载或解码，请确认网页图片完整显示后重试");
            if (!aiImagePublicUrl(url)) return aiImageError("此图片只能从本地或内网读取，请加载图片后重试或手动处理");
            if (Math.max(width, height) > maxSide) return aiImageError("图片尺寸超过模型限制，且无法缩小，请手动处理此题");
            if (url.href.length > 8192) return aiImageError("图片地址过长，请手动处理此题");
            resolved = url.href;
          }
        }
        totalBytes += bytes;
        if (totalBytes > AI_IMAGE_LIMITS.totalBytes) return aiImageError("每题图片数据合计超过 20 MiB，请手动处理此题");
        images.push({marker: descriptor.marker, label: descriptor.label, url: resolved});
        // Give cancellation and navigation a chance between larger encodings.
        await Promise.resolve();
      } catch { return aiImageError("图片读取失败，请手动处理此题"); }
    }
    return aiImageCurrent(context) ? {images} : aiImageError("请求已取消");
  };
