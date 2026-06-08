const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const GENERATED_DIR = path.join(__dirname, "generated");
const IMAGE_SCRIPT = path.join(
  ROOT_DIR,
  ".agents",
  "skills",
  "插画格配图生成skill",
  "scripts",
  "generate_article_illustrations.py"
);

const PYTHON_BIN = process.env.PYTHON_BIN || "/usr/bin/python3";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_APIMART_MODEL = "gemini-3-pro-image-preview";

fs.mkdirSync(GENERATED_DIR, { recursive: true });
loadEnvFile(path.join(ROOT_DIR, ".deepseek.env"));
loadEnvFile(path.join(__dirname, ".deepseek.env"));
loadEnvFile(path.join(ROOT_DIR, ".apimart.env"));

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [rawKey, ...rest] = line.split("=");
    const key = rawKey.trim();
    let value = rest.join("=").trim();
    if (!key || process.env[key]) continue;
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return true;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function safeJoin(root, requestPath) {
  const normalized = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const result = path.join(root, normalized);
  if (!result.startsWith(root)) throw new Error("Unsafe path.");
  return result;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return types[ext] || "application/octet-stream";
}

function serveFile(res, root, pathname) {
  let filePath;
  try {
    filePath = safeJoin(root, pathname === "/" ? "/index.html" : pathname);
  } catch (error) {
    return sendText(res, 400, "Bad request.");
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return sendText(res, 404, "Not found.");
  }
  res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
  fs.createReadStream(filePath).pipe(res);
}

function slugTimeId(keyword) {
  const time = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const ascii = String(keyword || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const suffix = crypto.randomBytes(3).toString("hex");
  return [ascii || "article", time, suffix].join("-");
}

function assertArticleId(id) {
  if (!/^[a-z0-9-]{8,80}$/.test(String(id || ""))) {
    throw new Error("Invalid article id.");
  }
}

function articleDir(articleId) {
  assertArticleId(articleId);
  return path.join(GENERATED_DIR, articleId);
}

function getDeepSeekConfig() {
  return {
    configured: Boolean(process.env.DEEPSEEK_API_KEY),
    baseUrl: process.env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL,
    model: process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL,
  };
}

function getApimartConfig() {
  return {
    configured: Boolean(process.env.APIMART_API_KEY),
    model: process.env.APIMART_IMAGE_MODEL || DEFAULT_APIMART_MODEL,
  };
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function stripCodeFence(markdown) {
  return String(markdown || "")
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractTitle(markdown, keyword) {
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(/^#\s+(.+)$/);
    if (match) return match[1].trim().slice(0, 80);
  }
  return String(keyword || "未命名文章").trim().slice(0, 80) || "未命名文章";
}

function buildArticlePrompt(input) {
  const wordCount = clampNumber(input.wordCount, 1800, 800, 4000);
  const platform = String(input.platform || "公众号").trim();
  const angle = String(input.angle || "").trim();
  const keyword = String(input.keyword || "").trim();
  const audience = String(input.audience || "中文内容平台读者").trim();

  return {
    wordCount,
    messages: [
      {
        role: "system",
        content:
          "你是资深中文自媒体作者和编辑。写作要求：观点明确，结构清晰，有真实作者的判断；不要空泛鸡汤，不要营销腔，不要AI腔；输出纯 Markdown，不要代码块；只写中文内容；开头必须是一个 # 标题；不要插入图片占位符。",
      },
      {
        role: "user",
        content: [
          `关键词：${keyword}`,
          `目标平台：${platform}`,
          `目标读者：${audience}`,
          angle ? `写作角度：${angle}` : "写作角度：请自行选择一个更有信息密度、更适合传播的角度。",
          `长度：约 ${wordCount} 个中文字符。`,
          "",
          "请生成一篇可直接发布的中文文章，要求：",
          "1. 标题具体，不要大而空。",
          "2. 开头快速进入问题，不写套话。",
          "3. 中段要有可执行的方法、判断标准或案例化表达。",
          "4. 结尾要有收束感，不要喊口号。",
          "5. 用 Markdown 的 #、##、### 和段落组织内容。",
        ].join("\n"),
      },
    ],
  };
}

async function callDeepSeek(input) {
  const config = getDeepSeekConfig();
  if (!config.configured) {
    throw new Error("DeepSeek API key is missing. Add DEEPSEEK_API_KEY to .deepseek.env.");
  }
  const { wordCount, messages } = buildArticlePrompt(input);
  const maxTokens = clampNumber(wordCount * 2, 3600, 1800, 7000);
  const payload = {
    model: config.model,
    messages,
    temperature: 0.82,
    max_tokens: maxTokens,
  };
  if (config.model.startsWith("deepseek-v4")) {
    payload.thinking = { type: "disabled" };
  }

  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`DeepSeek returned non-JSON response: ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`DeepSeek HTTP ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
  }
  const markdown = stripCodeFence(data?.choices?.[0]?.message?.content || "");
  if (!markdown) throw new Error("DeepSeek returned an empty article.");
  return markdown;
}

function saveArticle(input, markdown) {
  const id = slugTimeId(input.keyword);
  const dir = articleDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });

  const title = extractTitle(markdown, input.keyword);
  const meta = {
    id,
    title,
    keyword: String(input.keyword || "").trim(),
    platform: String(input.platform || "公众号").trim(),
    angle: String(input.angle || "").trim(),
    wordCount: clampNumber(input.wordCount, 1800, 800, 4000),
    createdAt: new Date().toISOString(),
    markdown,
  };
  fs.writeFileSync(path.join(dir, "article.md"), markdown + "\n", "utf8");
  fs.writeFileSync(path.join(dir, "article.json"), JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

function readArticleMeta(articleId) {
  const filePath = path.join(articleDir(articleId), "article.json");
  if (!fs.existsSync(filePath)) throw new Error("Article not found.");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function updateArticleMarkdown(articleId, markdown) {
  const meta = readArticleMeta(articleId);
  const cleaned = stripCodeFence(markdown);
  if (!cleaned) throw new Error("Article markdown cannot be empty.");
  const updated = {
    ...meta,
    title: extractTitle(cleaned, meta.keyword),
    markdown: cleaned,
    updatedAt: new Date().toISOString(),
  };
  const dir = articleDir(articleId);
  fs.writeFileSync(path.join(dir, "article.md"), cleaned + "\n", "utf8");
  fs.writeFileSync(path.join(dir, "article.json"), JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

function manifestToImages(articleId) {
  const manifestPath = path.join(articleDir(articleId), "images", "manifest.json");
  if (!fs.existsSync(manifestPath)) return [];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const labels = { front: "前段配图", middle: "中段配图", ending: "尾段配图" };
  return (manifest.items || [])
    .filter((item) => item.status === "completed" && item.output_path)
    .map((item) => {
      const filename = path.basename(item.output_path);
      return {
        slot: item.key,
        label: labels[item.key] || item.label || item.key,
        prompt: item.prompt || "",
        excerpt: item.excerpt || "",
        src: `/generated/${articleId}/images/${filename}`,
      };
    });
}

function runImageScript(articleId, options = {}) {
  const config = getApimartConfig();
  if (!config.configured) {
    return Promise.reject(new Error("APIMart API key is missing. Add APIMART_API_KEY to .apimart.env."));
  }

  const dir = articleDir(articleId);
  const articlePath = path.join(dir, "article.md");
  const outputDir = path.join(dir, "images");
  const size = options.size || "16:9";
  const resolution = options.resolution || "2K";
  const args = [
    IMAGE_SCRIPT,
    articlePath,
    "--output-dir",
    outputDir,
    "--size",
    size,
    "--resolution",
    resolution,
    "--model",
    config.model,
    "--resume",
  ];

  if (options.only) {
    args.push("--only", options.only, "--force");
  }

  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(PYTHON_BIN, args, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(stderr.trim() || stdout.trim() || `Image generation failed with code ${code}.`));
      }
      resolve({
        stdout,
        stderr,
        images: manifestToImages(articleId),
      });
    });
  });
}

function sampleArticle(input = {}) {
  const keyword = String(input.keyword || "AI 写作与配图工作流").trim();
  const markdown = [
    `# ${keyword}：把不确定的草稿变成可预览的成品`,
    "",
    "很多自媒体作者真正头疼的不是写不出文字，而是写完之后不知道它最终会长什么样。文章、配图、排版分散在不同文件夹里，预览靠想象，插图靠手工搬运，这会让一个本该流畅的创作过程变得像反复返工。",
    "",
    "## 问题不在生成，而在闭环",
    "",
    "如果系统只负责生成文章，作者还要自己找图、插图、检查效果，它只是把第一步变快了。真正有价值的工具应该把文章生成、配图生成、位置调整和最终导出放在同一个工作台里，让作者在一个界面内看到完整草稿。",
    "",
    "## 好的预览应该能调整",
    "",
    "配图不是固定答案。前段图可以承担引入，中段图可以解释方法，尾段图可以负责收束。但实际阅读时，作者可能会发现某张图更适合提前，或者某张图需要重生。预览器必须允许移动、删除、替换，而不是把模型输出当成不可修改的成品。",
    "",
    "## 下载 HTML 是最后的安全感",
    "",
    "当作者调整完文章和配图后，系统应该给出一个可保存、可分享、可继续加工的 HTML 文件。这样，生成不再只是一次对话里的结果，而会变成一个真正可交付的草稿。"
  ].join("\n");
  return saveArticle({ ...input, keyword }, markdown);
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, 200, {
        deepseek: getDeepSeekConfig(),
        apimart: getApimartConfig(),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/sample-article") {
      const body = await readJson(req);
      return sendJson(res, 200, { article: sampleArticle(body) });
    }

    if (req.method === "POST" && url.pathname === "/api/generate-article") {
      const body = await readJson(req);
      if (!String(body.keyword || "").trim()) {
        return sendJson(res, 400, { error: "请输入关键词。" });
      }
      const markdown = await callDeepSeek(body);
      return sendJson(res, 200, { article: saveArticle(body, markdown) });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/articles/")) {
      const articleId = decodeURIComponent(url.pathname.split("/").pop());
      return sendJson(res, 200, {
        article: readArticleMeta(articleId),
        images: manifestToImages(articleId),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/update-article") {
      const body = await readJson(req);
      assertArticleId(body.articleId);
      return sendJson(res, 200, {
        article: updateArticleMarkdown(body.articleId, body.markdown),
        images: manifestToImages(body.articleId),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/generate-images") {
      const body = await readJson(req);
      assertArticleId(body.articleId);
      const result = await runImageScript(body.articleId, {
        size: body.size || "16:9",
        resolution: body.resolution || "2K",
      });
      return sendJson(res, 200, { images: result.images, log: result.stderr });
    }

    if (req.method === "POST" && url.pathname === "/api/regenerate-image") {
      const body = await readJson(req);
      assertArticleId(body.articleId);
      if (!["front", "middle", "ending"].includes(body.slot)) {
        return sendJson(res, 400, { error: "Invalid image slot." });
      }
      const result = await runImageScript(body.articleId, {
        only: body.slot,
        size: body.size || "16:9",
        resolution: body.resolution || "2K",
      });
      return sendJson(res, 200, { images: result.images, log: result.stderr });
    }

    return sendJson(res, 404, { error: "API not found." });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || String(error) });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url);
  }
  if (url.pathname.startsWith("/generated/")) {
    return serveFile(res, GENERATED_DIR, url.pathname.replace(/^\/generated/, ""));
  }
  return serveFile(res, PUBLIC_DIR, url.pathname);
});

function listen(port, attempts = 0) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attempts < 20) {
      return listen(port + 1, attempts + 1);
    }
    console.error(error);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    console.log(`Article Studio running at http://127.0.0.1:${address.port}`);
  });
}

listen(Number(process.env.PORT || 8787));
