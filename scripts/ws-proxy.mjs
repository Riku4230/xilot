import { createServer, request as httpRequest } from "http";
import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve, sep } from "path";

const PROXY_PORT = Number(process.env.XILOT_PROXY_PORT || 4501);
const CODEX_HOST = process.env.XILOT_CODEX_HOST || "127.0.0.1";
const CODEX_PORT = Number(process.env.XILOT_CODEX_PORT || 4500);
const DEFAULT_SAVE_DIR = join(homedir(), "xilot");

const TOKEN_PATH = join(process.env.HOME || "~", ".codex", "xilot-proxy-token");
let PROXY_TOKEN = "";
try {
  PROXY_TOKEN = readFileSync(TOKEN_PATH, "utf-8").trim();
} catch {
  console.error(`Token file not found: ${TOKEN_PATH}`);
  process.exit(1);
}

const server = createServer((req, res) => {
  void handleHttp(req, res);
});

async function handleHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (url.pathname === "/healthz") {
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (url.pathname === "/local-save" && req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/local-save" && req.method === "POST") {
    setCorsHeaders(res);
    if (!isAuthorized(req, url)) {
      sendJson(res, 403, { ok: false, error: "Forbidden" });
      return;
    }

    try {
      const payload = await readJsonBody(req);
      const result = await saveLocalArchive(payload);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  res.writeHead(404);
  res.end();
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function isAuthorized(req, url) {
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  const token = bearer || url.searchParams.get("token") || "";
  return token === PROXY_TOKEN;
}

function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        reject(new Error("保存データが大きすぎます"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolvePromise(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("保存データのJSONを読めません"));
      }
    });
    req.on("error", reject);
  });
}

async function saveLocalArchive(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("保存データが空です");
  }
  if (!payload.article || !payload.translation) {
    throw new Error("記事と翻訳結果が必要です");
  }

  const baseDir = resolveSaveBaseDir(payload.baseDir);
  const articleId = makeArticleId(payload.article);
  const contentKind = payload.article.kind === "post" ? "post" : "article";
  const articleDir = join(baseDir, contentKind, articleId);
  const files = [];

  mkdirSync(articleDir, { recursive: true });
  writeTextFile(join(articleDir, "original.md"), renderOriginalMarkdown(payload.article), files);
  writeTextFile(join(articleDir, "translation.md"), renderTranslationMarkdown(payload.translation), files);
  writeTextFile(
    join(articleDir, "metadata.json"),
    JSON.stringify({
      kind: contentKind,
      url: payload.article.url,
      canonicalUrl: payload.article.canonicalUrl || payload.article.url,
      title: payload.article.title,
      author: payload.article.author,
      timestamp: payload.article.timestamp,
      links: Array.isArray(payload.article.links) ? payload.article.links : [],
      media: Array.isArray(payload.article.media) ? payload.article.media : [],
      savedAt: new Date().toISOString(),
    }, null, 2),
    files,
  );
  if (Array.isArray(payload.article.links) && payload.article.links.length > 0) {
    writeTextFile(join(articleDir, "links.json"), JSON.stringify(payload.article.links, null, 2), files);
  }
  const mediaFiles = await saveSourceMedia(articleDir, payload.article.media, files);

  let sessionDir = "";
  if (payload.session) {
    sessionDir = saveSessionArchive(baseDir, contentKind, articleId, articleDir, payload.article, payload.session, files);
  }

  return { baseDir, contentKind, articleId, articleDir, sessionDir, mediaFiles, files };
}

function resolveSaveBaseDir(input) {
  const home = resolve(homedir());
  const raw = typeof input === "string" && input.trim() ? input.trim() : DEFAULT_SAVE_DIR;
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
  const resolved = resolve(expanded);

  if (resolved !== home && !resolved.startsWith(home + sep)) {
    throw new Error("保存先はホームディレクトリ配下を指定してください");
  }
  return resolved;
}

function saveSessionArchive(baseDir, contentKind, articleId, articleDir, article, session, files) {
  const sessionId = sanitizeSegment(session.sessionId || `session-${Date.now()}`, "session");
  const sessionDir = contentKind === "post"
    ? join(articleDir, "session", sessionId)
    : join(baseDir, "session", articleId, sessionId);
  const imagesDir = join(sessionDir, "images");
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const cleanMessages = [];
  const chatParts = [
    `# ${article.title || session.articleTitle || "Untitled"}`,
    "",
    `- URL: ${article.url || session.articleUrl || ""}`,
    `- Session: ${sessionId}`,
    `- Saved: ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ];
  let imageCounter = 0;

  mkdirSync(imagesDir, { recursive: true });

  for (const message of messages) {
    const role = message.role === "user" ? "User" : "Assistant";
    const cleanMessage = {
      role: message.role === "user" ? "user" : "assistant",
      content: String(message.content || ""),
      createdAt: Number(message.createdAt) || Date.now(),
      images: [],
    };

    chatParts.push(`## ${role}`, "", cleanMessage.content || "");

    const images = Array.isArray(message.images) ? message.images : [];
    for (const image of images) {
      imageCounter += 1;
      const mimeType = image.mimeType || "image/png";
      const ext = mimeToExtension(mimeType);
      const fileName = `image-${String(imageCounter).padStart(3, "0")}.${ext}`;
      const imagePath = join(imagesDir, fileName);
      writeBase64Image(imagePath, image.base64, files);

      const relativePath = `./images/${fileName}`;
      chatParts.push("", `![generated image](${relativePath})`);
      if (image.revisedPrompt) {
        chatParts.push("", `> ${String(image.revisedPrompt).replace(/\n/g, "\n> ")}`);
      }
      cleanMessage.images.push({
        id: image.id || fileName,
        file: relativePath,
        revisedPrompt: image.revisedPrompt || "",
        mimeType,
        createdAt: Number(image.createdAt) || Date.now(),
      });
    }

    chatParts.push("");
    cleanMessages.push(cleanMessage);
  }

  writeTextFile(join(sessionDir, "chat.md"), chatParts.join("\n").trimEnd() + "\n", files);
  writeTextFile(
    join(sessionDir, "session.json"),
    JSON.stringify({
      sessionId,
      articleId,
      articleUrl: article.url || session.articleUrl || "",
      articleTitle: article.title || session.articleTitle || "",
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      savedAt: new Date().toISOString(),
      messages: cleanMessages,
    }, null, 2),
    files,
  );

  return sessionDir;
}

async function saveSourceMedia(articleDir, media, files) {
  if (!Array.isArray(media) || media.length === 0) return [];

  const mediaDir = join(articleDir, "images");
  mkdirSync(mediaDir, { recursive: true });
  const saved = [];

  for (let index = 0; index < media.length; index++) {
    const item = media[index];
    if (!item?.url || item.type !== "image") continue;

    try {
      const response = await fetch(item.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 Xilot/0.1",
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentType = response.headers.get("content-type") || "";
      const ext = extensionFromMedia(item.url, contentType);
      const fileName = `media-${String(index + 1).padStart(3, "0")}.${ext}`;
      const filePath = join(mediaDir, fileName);
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(filePath, buffer);
      files.push(filePath);
      saved.push({
        sourceUrl: item.url,
        file: `./images/${fileName}`,
        alt: item.alt || "",
        contentType,
      });
    } catch (error) {
      saved.push({
        sourceUrl: item.url,
        file: "",
        alt: item.alt || "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  writeTextFile(join(articleDir, "media.json"), JSON.stringify(saved, null, 2), files);
  return saved;
}

function writeTextFile(filePath, content, files) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  files.push(filePath);
}

function writeBase64Image(filePath, value, files) {
  if (!value) return;
  const raw = String(value);
  const match = raw.match(/^data:([^;]+);base64,(.*)$/);
  const base64 = (match ? match[2] : raw).replace(/\s/g, "");
  writeFileSync(filePath, Buffer.from(base64, "base64"));
  files.push(filePath);
}

function renderOriginalMarkdown(article) {
  return [
    `# ${article.title || "Untitled"}`,
    "",
    `- Type: ${article.kind === "post" ? "Post" : "Article"}`,
    `- URL: ${article.url || ""}`,
    `- Canonical URL: ${article.canonicalUrl || article.url || ""}`,
    `- Author: ${article.author || ""}`,
    `- Published: ${article.timestamp || ""}`,
    "",
    ...renderLinksSection(article.links),
    ...renderMediaSection(article.media),
    "---",
    "",
    ...(Array.isArray(article.blocks)
      ? article.blocks.filter((block) => block.type !== "title").map((block) => blockToMarkdown(block, block.text))
      : []),
    "",
  ].join("\n");
}

function renderTranslationMarkdown(translation) {
  return [
    `# ${getTranslatedTitle(translation)}`,
    "",
    `- URL: ${translation.url || ""}`,
    `- Author: ${translation.author || ""}`,
    "",
    "---",
    "",
    ...(Array.isArray(translation.blocks)
      ? translation.blocks
        .filter((block) => block.type !== "title")
        .map((block) => blockToMarkdown(block, block.translated))
      : []),
    "",
  ].join("\n");
}

function getTranslatedTitle(translation) {
  const titleBlock = Array.isArray(translation.blocks)
    ? translation.blocks.find((block) => block.type === "title")
    : null;
  return titleBlock?.translated || translation.title || "Untitled";
}

function blockToMarkdown(block, textValue) {
  const text = String(textValue || "").trim();
  if (!text) return "";

  switch (block.type) {
    case "title":
      return `# ${text}`;
    case "heading":
      return `## ${text}`;
    case "blockquote":
      return text.split("\n").map((line) => `> ${line}`).join("\n");
    case "list-item":
      return text.split("\n").map((line) => `- ${line}`).join("\n");
    case "code":
      return ["```", text, "```"].join("\n");
    default:
      return text;
  }
}

function makeArticleId(article) {
  if (article.kind === "post") {
    const statusId = String(article.canonicalUrl || article.url || "").match(/\/status\/(\d+)/)?.[1];
    const date = parseDatePart(article.timestamp);
    if (statusId) return `${date}-post-${statusId}`;
  }

  const title = sanitizeSegment(article.title || "article", "article").slice(0, 72);
  const date = parseDatePart(article.timestamp);
  const hash = createHash("sha256")
    .update(`${article.url || ""}\n${article.title || ""}`)
    .digest("hex")
    .slice(0, 8);
  return `${date}-${title}-${hash}`;
}

function renderLinksSection(links) {
  if (!Array.isArray(links) || links.length === 0) return [];
  return [
    "## Links",
    "",
    ...links.map((link) => `- [${escapeMarkdownLinkText(link.text || link.url)}](${link.url})`),
    "",
  ];
}

function renderMediaSection(media) {
  if (!Array.isArray(media) || media.length === 0) return [];
  return [
    "## Media",
    "",
    ...media.map((item) => `- ${item.type}: ${item.url}${item.alt ? ` (${item.alt})` : ""}`),
    "",
  ];
}

function escapeMarkdownLinkText(value) {
  return String(value || "").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function extensionFromMedia(urlValue, contentType) {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";

  try {
    const url = new URL(urlValue);
    const format = url.searchParams.get("format");
    if (format) return format === "jpeg" ? "jpg" : format;
    const ext = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1];
    if (ext) return ext === "jpeg" ? "jpg" : ext;
  } catch {
    // Fall through to the default extension.
  }

  return "jpg";
}

function parseDatePart(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.valueOf())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function sanitizeSegment(value, fallback) {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+$/, "")
    .trim();
  return cleaned || fallback;
}

function mimeToExtension(mimeType) {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

server.on("upgrade", (clientReq, clientSocket) => {
  const url = new URL(clientReq.url || "/", `http://${clientReq.headers.host}`);
  const token = url.searchParams.get("token") || "";

  if (token !== PROXY_TOKEN) {
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const codexReq = httpRequest({
    host: CODEX_HOST,
    port: CODEX_PORT,
    path: "/",
    method: "GET",
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": clientReq.headers["sec-websocket-key"],
    },
  });

  codexReq.on("upgrade", (_res, codexSocket, codexHead) => {
    const accept = _res.headers["sec-websocket-accept"];
    clientSocket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      "\r\n"
    );
    if (codexHead.length > 0) clientSocket.write(codexHead);

    codexSocket.pipe(clientSocket);
    clientSocket.pipe(codexSocket);

    codexSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => codexSocket.destroy());
    codexSocket.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => codexSocket.destroy());
  });

  codexReq.on("response", (res) => {
    clientSocket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n\r\n`);
    res.pipe(clientSocket);
  });

  codexReq.on("error", (err) => {
    console.error("Codex error:", err.message);
    clientSocket.destroy();
  });

  codexReq.end();
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`WS proxy: ws://127.0.0.1:${PROXY_PORT} -> ws://${CODEX_HOST}:${CODEX_PORT} (auth required)`);
});
