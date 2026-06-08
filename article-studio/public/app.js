const els = {
  deepseekStatus: document.getElementById("deepseekStatus"),
  apimartStatus: document.getElementById("apimartStatus"),
  keywordInput: document.getElementById("keywordInput"),
  angleInput: document.getElementById("angleInput"),
  platformInput: document.getElementById("platformInput"),
  wordCountInput: document.getElementById("wordCountInput"),
  generateArticleBtn: document.getElementById("generateArticleBtn"),
  generateImagesBtn: document.getElementById("generateImagesBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  sampleBtn: document.getElementById("sampleBtn"),
  markdownEditor: document.getElementById("markdownEditor"),
  applyMarkdownBtn: document.getElementById("applyMarkdownBtn"),
  articlePreview: document.getElementById("articlePreview"),
  imageList: document.getElementById("imageList"),
  imageCount: document.getElementById("imageCount"),
  selectedSlot: document.getElementById("selectedSlot"),
  moveUpBtn: document.getElementById("moveUpBtn"),
  moveDownBtn: document.getElementById("moveDownBtn"),
  regenerateBtn: document.getElementById("regenerateBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  imageSizeInput: document.getElementById("imageSizeInput"),
  resolutionInput: document.getElementById("resolutionInput"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  logBox: document.getElementById("logBox"),
};

const state = {
  article: null,
  blocks: [],
  layout: [],
  images: [],
  selectedSlot: null,
  style: "wechat",
  busy: false,
};

const slotOrder = ["front", "middle", "ending"];
const slotNames = {
  front: "前段配图",
  middle: "中段配图",
  ending: "尾段配图",
};

function log(message) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  els.logBox.textContent = `[${time}] ${message}\n${els.logBox.textContent}`.slice(0, 6000);
}

function setBusy(isBusy, message) {
  state.busy = isBusy;
  [
    els.generateArticleBtn,
    els.generateImagesBtn,
    els.downloadBtn,
    els.sampleBtn,
    els.applyMarkdownBtn,
    els.moveUpBtn,
    els.moveDownBtn,
    els.regenerateBtn,
    els.deleteBtn,
  ].forEach((button) => {
    button.disabled = isBusy || button.dataset.locked === "true";
  });
  if (message) log(message);
  refreshControls();
}

function refreshControls() {
  const hasArticle = Boolean(state.article);
  const hasSelected = Boolean(state.selectedSlot && state.layout.some((item) => item.type === "figure" && item.slot === state.selectedSlot));
  els.generateImagesBtn.disabled = state.busy || !hasArticle;
  els.downloadBtn.disabled = state.busy || !hasArticle;
  els.applyMarkdownBtn.disabled = state.busy || !hasArticle;
  els.moveUpBtn.disabled = state.busy || !hasSelected;
  els.moveDownBtn.disabled = state.busy || !hasSelected;
  els.regenerateBtn.disabled = state.busy || !hasSelected;
  els.deleteBtn.disabled = state.busy || !hasSelected;
  els.selectedSlot.textContent = hasSelected ? slotNames[state.selectedSlot] : "未选择";
  const figureCount = state.layout.filter((item) => item.type === "figure").length;
  els.imageCount.textContent = `${figureCount}/3`;
}

async function api(path, payload) {
  const response = await fetch(path, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function setStatus(el, configured, label, detail) {
  el.classList.toggle("ok", configured);
  el.classList.toggle("warn", !configured);
  el.textContent = `${label} ${configured ? "已配置" : "未配置"}${detail ? ` · ${detail}` : ""}`;
}

async function loadStatus() {
  try {
    const data = await api("/api/status");
    setStatus(els.deepseekStatus, data.deepseek.configured, "DeepSeek", data.deepseek.model);
    setStatus(els.apimartStatus, data.apimart.configured, "APIMart", data.apimart.model);
    if (!data.deepseek.configured) log("DeepSeek 未配置：在项目根目录创建 .deepseek.env 并写入 DEEPSEEK_API_KEY。");
    if (!data.apimart.configured) log("APIMart 未配置：配图会等待 .apimart.env 中的 APIMART_API_KEY。");
  } catch (error) {
    log(`状态检查失败：${error.message}`);
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineFormat(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function parseMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    blocks.push({ type: "p", text: paragraph.join(" ").trim() });
    paragraph = [];
  }

  function flushList() {
    if (!list.length) return;
    blocks.push({ type: "ul", items: list });
    list = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: `h${heading[1].length}`, text: heading[2].trim() });
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1].trim());
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks.map((block, index) => ({ ...block, id: `text-${index}` }));
}

function renderBlock(block) {
  if (block.type === "figure") {
    const selected = block.slot === state.selectedSlot ? " is-selected" : "";
    return `
      <figure class="article-figure${selected}" data-slot="${block.slot}">
        <img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.label)}" />
        <figcaption>${escapeHtml(block.label)}</figcaption>
      </figure>
    `;
  }
  if (block.type === "ul") {
    return `<ul>${block.items.map((item) => `<li>${inlineFormat(item)}</li>`).join("")}</ul>`;
  }
  if (["h1", "h2", "h3"].includes(block.type)) {
    return `<${block.type}>${inlineFormat(block.text)}</${block.type}>`;
  }
  return `<p>${inlineFormat(block.text)}</p>`;
}

function renderPreview() {
  els.articlePreview.className = `article-preview ${state.style} panel`;
  if (!state.article) {
    els.articlePreview.innerHTML = `
      <div class="empty-state">
        <h2>等待生成</h2>
        <p>输入关键词后生成文章，再生成三张配图。</p>
      </div>
    `;
    renderImageList();
    refreshControls();
    return;
  }
  els.articlePreview.innerHTML = `<div class="article-inner">${state.layout.map(renderBlock).join("")}</div>`;
  els.articlePreview.querySelectorAll(".article-figure").forEach((figure) => {
    figure.addEventListener("click", () => {
      state.selectedSlot = figure.dataset.slot;
      renderPreview();
    });
  });
  renderImageList();
  refreshControls();
}

function sortImages(images) {
  return [...images].sort((a, b) => slotOrder.indexOf(a.slot) - slotOrder.indexOf(b.slot));
}

function imageWithCacheBust(image) {
  const separator = image.src.includes("?") ? "&" : "?";
  return { ...image, src: `${image.src}${separator}v=${Date.now()}` };
}

function createLayout(images = []) {
  const textBlocks = [...state.blocks];
  const result = [...textBlocks];
  const sorted = sortImages(images);
  const positions = {
    front: Math.max(1, Math.floor(textBlocks.length * 0.28)),
    middle: Math.max(2, Math.floor(textBlocks.length * 0.58)),
    ending: textBlocks.length,
  };

  for (const image of [...sorted].reverse()) {
    const index = Math.min(result.length, positions[image.slot] ?? result.length);
    result.splice(index, 0, {
      type: "figure",
      slot: image.slot,
      label: image.label || slotNames[image.slot] || image.slot,
      src: image.src,
      prompt: image.prompt || "",
    });
  }
  state.layout = result;
}

function renderImageList() {
  const figures = state.layout.filter((item) => item.type === "figure");
  if (!figures.length) {
    els.imageList.innerHTML = `<div class="empty-state" style="margin:0;padding:18px;"><p>暂无配图</p></div>`;
    return;
  }
  els.imageList.innerHTML = figures
    .map(
      (figure) => `
      <button class="image-item ${figure.slot === state.selectedSlot ? "is-selected" : ""}" data-slot="${figure.slot}" type="button">
        <img src="${escapeHtml(figure.src)}" alt="${escapeHtml(figure.label)}" />
        <span>
          <strong>${escapeHtml(figure.label)}</strong>
          <span>${escapeHtml(figure.slot)}</span>
        </span>
      </button>
    `
    )
    .join("");
  els.imageList.querySelectorAll(".image-item").forEach((item) => {
    item.addEventListener("click", () => {
      state.selectedSlot = item.dataset.slot;
      renderPreview();
    });
  });
}

function articlePayload() {
  return {
    keyword: els.keywordInput.value.trim(),
    angle: els.angleInput.value.trim(),
    platform: els.platformInput.value,
    wordCount: Number(els.wordCountInput.value || 1800),
  };
}

function loadArticle(article, images = []) {
  state.article = article;
  state.blocks = parseMarkdown(article.markdown);
  state.images = sortImages(images);
  state.selectedSlot = null;
  els.markdownEditor.value = article.markdown;
  createLayout(state.images);
  renderPreview();
}

async function generateArticle() {
  const payload = articlePayload();
  if (!payload.keyword) {
    log("关键词不能为空。");
    return;
  }
  setBusy(true, "正在调用 DeepSeek 生成文章。");
  try {
    const data = await api("/api/generate-article", payload);
    loadArticle(data.article, []);
    log(`文章已生成：${data.article.title}`);
  } catch (error) {
    log(`文章生成失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function loadSample() {
  setBusy(true, "正在载入示例稿。");
  try {
    const data = await api("/api/sample-article", articlePayload());
    loadArticle(data.article, []);
    log(`示例稿已载入：${data.article.title}`);
  } catch (error) {
    log(`示例稿载入失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function applyMarkdown() {
  if (!state.article) return;
  setBusy(true, "正在应用正文修改。");
  try {
    const data = await api("/api/update-article", {
      articleId: state.article.id,
      markdown: els.markdownEditor.value,
    });
    loadArticle(data.article, data.images || []);
    log("正文修改已应用。");
  } catch (error) {
    log(`正文保存失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function generateImages() {
  if (!state.article) return;
  setBusy(true, "正在调用 APIMart 生成三张配图，可能需要几分钟。");
  try {
    const data = await api("/api/generate-images", {
      articleId: state.article.id,
      size: els.imageSizeInput.value,
      resolution: els.resolutionInput.value,
    });
    state.images = sortImages(data.images || []).map(imageWithCacheBust);
    createLayout(state.images);
    state.selectedSlot = state.images[0]?.slot || null;
    renderPreview();
    log("三张配图已生成并插入预览。");
  } catch (error) {
    log(`配图生成失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function regenerateSelected() {
  if (!state.article || !state.selectedSlot) return;
  const slot = state.selectedSlot;
  setBusy(true, `正在重新生成${slotNames[slot]}。`);
  try {
    const data = await api("/api/regenerate-image", {
      articleId: state.article.id,
      slot,
      size: els.imageSizeInput.value,
      resolution: els.resolutionInput.value,
    });
    const nextImages = sortImages(data.images || []).map((image) => (image.slot === slot ? imageWithCacheBust(image) : image));
    const fresh = nextImages.find((image) => image.slot === slot);
    if (fresh) {
      state.layout = state.layout.map((item) => (item.type === "figure" && item.slot === slot ? { ...item, ...fresh, type: "figure" } : item));
      state.images = nextImages;
    }
    renderPreview();
    log(`${slotNames[slot]}已重新生成。`);
  } catch (error) {
    log(`重新生成失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function moveSelected(delta) {
  if (!state.selectedSlot) return;
  const index = state.layout.findIndex((item) => item.type === "figure" && item.slot === state.selectedSlot);
  const nextIndex = index + delta;
  if (index < 0 || nextIndex < 0 || nextIndex >= state.layout.length) return;
  const nextLayout = [...state.layout];
  const [item] = nextLayout.splice(index, 1);
  nextLayout.splice(nextIndex, 0, item);
  state.layout = nextLayout;
  renderPreview();
}

function deleteSelected() {
  if (!state.selectedSlot) return;
  const slot = state.selectedSlot;
  state.layout = state.layout.filter((item) => !(item.type === "figure" && item.slot === slot));
  state.selectedSlot = null;
  renderPreview();
  log(`${slotNames[slot]}已从预览中删除。`);
}

function exportStyles() {
  return `
    body{margin:0;background:#f7f4ed;color:#23201d;font-family:"Avenir Next","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;}
    .article-inner{width:min(760px,calc(100% - 38px));margin:32px auto;background:#fffdf8;border:1px solid #d9d1c2;padding:42px 44px;}
    .article-inner h1{margin:0 0 24px;font-size:32px;line-height:1.28;letter-spacing:0;}
    .article-inner h2{margin:34px 0 14px;padding-left:12px;border-left:5px solid #2d765f;font-size:22px;line-height:1.36;letter-spacing:0;}
    .article-inner h3{margin:26px 0 10px;color:#2f5e8f;font-size:18px;line-height:1.4;letter-spacing:0;}
    .article-inner p,.article-inner li{font-size:16px;line-height:1.9;letter-spacing:0;}
    .article-inner p{margin:14px 0;}
    .article-inner ul{margin:14px 0 18px;padding-left:24px;}
    .article-figure{margin:28px 0;padding:0;border:0;}
    .article-figure img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:6px;}
    .article-figure figcaption{margin-top:8px;color:#746f66;font-size:12px;font-weight:800;}
    @media(max-width:760px){.article-inner{width:calc(100% - 22px);padding:24px 20px}.article-inner h1{font-size:26px}}
  `;
}

async function toDataUrl(src) {
  const response = await fetch(src, { cache: "no-store" });
  if (!response.ok) throw new Error(`图片读取失败：${src}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function downloadHtml() {
  if (!state.article) return;
  setBusy(true, "正在打包 HTML。");
  try {
    const clone = els.articlePreview.querySelector(".article-inner").cloneNode(true);
    clone.querySelectorAll(".is-selected").forEach((node) => node.classList.remove("is-selected"));
    const images = [...clone.querySelectorAll("img")];
    for (const image of images) {
      image.src = await toDataUrl(image.getAttribute("src"));
    }
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(state.article.title)}</title>
  <style>${exportStyles()}</style>
</head>
<body>
  ${clone.outerHTML}
</body>
</html>`;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${state.article.id}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    log("HTML 已下载。");
  } catch (error) {
    log(`下载失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

els.generateArticleBtn.addEventListener("click", generateArticle);
els.generateImagesBtn.addEventListener("click", generateImages);
els.downloadBtn.addEventListener("click", downloadHtml);
els.sampleBtn.addEventListener("click", loadSample);
els.applyMarkdownBtn.addEventListener("click", applyMarkdown);
els.moveUpBtn.addEventListener("click", () => moveSelected(-1));
els.moveDownBtn.addEventListener("click", () => moveSelected(1));
els.regenerateBtn.addEventListener("click", regenerateSelected);
els.deleteBtn.addEventListener("click", deleteSelected);
els.clearLogBtn.addEventListener("click", () => {
  els.logBox.textContent = "";
});

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => {
    state.style = button.dataset.style;
    document.querySelectorAll(".segment").forEach((segment) => segment.classList.toggle("is-active", segment === button));
    renderPreview();
  });
});

loadStatus();
renderPreview();
