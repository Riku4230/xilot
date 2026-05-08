import type {
  ArticleBlock,
  ArticleData,
  ChatMessage,
  ChatSession,
  LocalSavePayload,
  MessageType,
  SessionImage,
  TranslatedBlock,
  TranslationResult,
} from "../lib/types";
import { QUICK_ACTIONS } from "../lib/prompts";
import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });

// --- Elements ---
const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
const viewTranslate = document.getElementById("view-translate")!;
const viewChat = document.getElementById("view-chat")!;
const viewSave = document.getElementById("view-save")!;

const stateInitial = document.getElementById("state-initial")!;
const stateTranslating = document.getElementById("state-translating")!;
const stateError = document.getElementById("state-error")!;
const articleMeta = document.getElementById("article-meta")!;
const translationBlocks = document.getElementById("translation-blocks")!;
const errorMessage = document.getElementById("error-message")!;
const retryBtn = document.getElementById("retry-btn")!;

const quickActionsEl = document.getElementById("quick-actions")!;
const chatMessages = document.getElementById("chat-messages")!;
const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
const chatSend = document.getElementById("chat-send") as HTMLButtonElement;
const sessionListBtn = document.getElementById("session-list-btn")!;
const sessionListEl = document.getElementById("session-list")!;
const sessionListItems = document.getElementById("session-list-items")!;
const sessionTitleEl = document.getElementById("session-title")!;
const newChatBtn = document.getElementById("new-chat-btn")!;

const savePathInput = document.getElementById("save-path-input") as HTMLInputElement;
const savePathResetBtn = document.getElementById("save-path-reset") as HTMLButtonElement;
const saveOnlyToggle = document.getElementById("save-only-toggle") as HTMLInputElement;
const saveCurrentBtn = document.getElementById("save-current-btn") as HTMLButtonElement;
const saveSummaryEl = document.getElementById("save-summary")!;
const saveStatusEl = document.getElementById("save-status")!;

// --- State ---
let currentArticleUrl = "";
let currentArticleText = "";
let currentArticleData: ArticleData | null = null;
let currentTranslationResult: TranslationResult | null = null;
let activeChatBubble: HTMLElement | null = null;
let chatBusy = false;
let saveBusy = false;
let saveBaseDir = "~/xilot";
let saveOnlyMode = false;
let pendingAssistantImages: SessionImage[] = [];
const DEFAULT_PROXY_TOKEN = "5f81c308b8f816ca72e3990e2cf77543";

// --- Session Management ---
let sessions: ChatSession[] = [];
let activeSessionIndex = -1;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMessage(message: Partial<ChatMessage>): ChatMessage {
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content || "",
    createdAt: message.createdAt || Date.now(),
    images: message.images || [],
  };
}

function normalizeSession(session: Partial<ChatSession>): ChatSession {
  const createdAt = session.createdAt || Date.now();
  return {
    sessionId: session.sessionId || makeId("session"),
    articleUrl: session.articleUrl || "",
    articleTitle: session.articleTitle || "新規チャット",
    messages: (session.messages || []).map(normalizeMessage),
    createdAt,
    updatedAt: session.updatedAt || createdAt,
  };
}

function loadSessions(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get(["xilotSessions"], (result) => {
      const storedSessions = Array.isArray(result.xilotSessions) ? result.xilotSessions : [];
      sessions = storedSessions.map(normalizeSession);
      resolve();
    });
  });
}

function saveSessions(): void {
  chrome.storage.local.set({ xilotSessions: sessions });
}

const sessionsReady = loadSessions();

function getOrCreateSession(url: string, title: string): ChatSession {
  let idx = sessions.findIndex((s) => s.articleUrl === url);
  if (idx === -1) {
    const now = Date.now();
    sessions.unshift({
      sessionId: makeId("session"),
      articleUrl: url,
      articleTitle: title,
      messages: [],
      createdAt: now,
      updatedAt: now,
    });
    idx = 0;
    saveSessions();
  }
  activeSessionIndex = idx;
  return sessions[idx];
}

function renderSessionHistory(): void {
  chatMessages.innerHTML = "";
  if (activeSessionIndex < 0) return;
  const session = sessions[activeSessionIndex];
  for (const msg of session.messages) {
    appendChatBubble(msg.role, msg.content, false, msg.images);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
  updateSaveSummary();
}

// --- Session List UI ---
function updateSessionTitle(): void {
  if (activeSessionIndex >= 0) {
    const s = sessions[activeSessionIndex];
    sessionTitleEl.textContent = s.articleTitle || "新規チャット";
  } else {
    sessionTitleEl.textContent = "新規チャット";
  }
}

function renderSessionList(): void {
  sessionListItems.innerHTML = "";
  if (sessions.length === 0) {
    sessionListItems.innerHTML = '<div class="session-empty">セッションがありません</div>';
    return;
  }
  sessions.forEach((s, idx) => {
    const item = document.createElement("div");
    item.className = `session-item${idx === activeSessionIndex ? " active" : ""}`;
    const date = new Date(s.createdAt);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
    item.innerHTML = `
      <span class="session-icon">💬</span>
      <div class="session-info">
        <div class="session-article-title">${s.articleTitle || "無題"}</div>
        <div class="session-meta">${s.messages.length}件 · ${dateStr}</div>
      </div>`;
    item.addEventListener("click", () => {
      activeSessionIndex = idx;
      renderSessionHistory();
      updateSessionTitle();
      sessionListEl.classList.add("hidden");
      activeChatBubble = null;
      pendingAssistantImages = [];
      setBusy(false);
    });
    sessionListItems.appendChild(item);
  });
}

sessionListBtn.addEventListener("click", () => {
  const isHidden = sessionListEl.classList.contains("hidden");
  if (isHidden) {
    renderSessionList();
    sessionListEl.classList.remove("hidden");
  } else {
    sessionListEl.classList.add("hidden");
  }
});

newChatBtn.addEventListener("click", () => {
  const now = Date.now();
  sessions.unshift({
    sessionId: makeId("session"),
    articleUrl: currentArticleUrl,
    articleTitle: sessions[activeSessionIndex]?.articleTitle || "新規チャット",
    messages: [],
    createdAt: now,
    updatedAt: now,
  });
  activeSessionIndex = 0;
  saveSessions();
  chatMessages.innerHTML = "";
  updateSessionTitle();
  updateSaveSummary();
  sessionListEl.classList.add("hidden");
  activeChatBubble = null;
  pendingAssistantImages = [];
  setBusy(false);
  chatInput.focus();
});

// --- Tab Switching ---
function updateTabLock(): void {
  const chatTab = document.querySelector('.tab[data-tab="chat"]') as HTMLButtonElement;
  if (chatTab) {
    const locked = isTranslating || saveOnlyMode;
    chatTab.disabled = locked;
    chatTab.classList.toggle("hidden-tab", saveOnlyMode);
    chatTab.style.opacity = locked ? "0.4" : "1";
    chatTab.style.cursor = locked ? "not-allowed" : "pointer";
  }
}

type ViewTab = "translate" | "chat" | "save";

function switchTab(tab: ViewTab): void {
  if (tab === "chat" && (isTranslating || saveOnlyMode)) return;
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  viewTranslate.classList.toggle("hidden", tab !== "translate");
  viewChat.classList.toggle("hidden", tab !== "chat");
  viewSave.classList.toggle("hidden", tab !== "save");
  if (tab === "chat") {
    chatInput.focus();
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  if (tab === "save") updateSaveSummary();
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab as ViewTab));
});

// --- View State ---
let isTranslating = false;

function showState(state: "initial" | "translating" | "error"): void {
  stateInitial.classList.toggle("hidden", state !== "initial");
  stateTranslating.classList.toggle("hidden", state !== "translating");
  stateError.classList.toggle("hidden", state !== "error");
  isTranslating = state === "translating";
  viewTranslate.style.overflowY = isTranslating ? "hidden" : "auto";
  if (isTranslating) viewTranslate.scrollTop = 0;
  updateTabLock();
}

function unlockScroll(): void {
  isTranslating = false;
  viewTranslate.style.overflowY = "auto";
  updateTabLock();
  updateSaveSummary();
}

// --- Local Save ---
function getStorage(keys: string[]): Promise<Record<string, any>> {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

async function loadSaveSettings(): Promise<void> {
  const settings = await getStorage(["xilotSaveBaseDir", "xilotSaveOnlyMode"]);
  saveBaseDir = settings.xilotSaveBaseDir || "~/xilot";
  saveOnlyMode = Boolean(settings.xilotSaveOnlyMode);
  savePathInput.value = saveBaseDir;
  saveOnlyToggle.checked = saveOnlyMode;
  updateTabLock();
  if (saveOnlyMode) switchTab("save");
  updateSaveSummary();
}

const saveSettingsReady = loadSaveSettings();

function countSessionImages(session: ChatSession | undefined): number {
  if (!session) return 0;
  return session.messages.reduce((count, message) => count + (message.images?.length || 0), 0);
}

function updateSaveSummary(): void {
  const blockCount = currentTranslationResult?.blocks.length || currentArticleData?.blocks.length || 0;
  const session = activeSessionIndex >= 0 ? sessions[activeSessionIndex] : undefined;
  const messageCount = session?.messages.length || 0;
  const imageCount = countSessionImages(session) + pendingAssistantImages.length;
  const sourceImageCount = currentArticleData?.media?.length || 0;
  saveSummaryEl.textContent = `${blockCount}ブロック / ${messageCount}件 / ${sourceImageCount}投稿画像 / ${imageCount}生成画像`;
  saveCurrentBtn.disabled = saveBusy || !currentArticleData || !currentTranslationResult;
}

function setSaveStatus(text: string, kind: "neutral" | "success" | "error" = "neutral"): void {
  saveStatusEl.textContent = text;
  saveStatusEl.className = kind;
}

function persistSavePath(): void {
  saveBaseDir = savePathInput.value.trim() || "~/xilot";
  savePathInput.value = saveBaseDir;
  void setStorage({ xilotSaveBaseDir: saveBaseDir });
}

async function saveCurrentArticle(): Promise<void> {
  await saveSettingsReady;
  persistSavePath();

  if (!currentArticleData || !currentTranslationResult) {
    setSaveStatus("翻訳完了後に保存できます", "error");
    updateSaveSummary();
    return;
  }

  const session = activeSessionIndex >= 0 ? sessions[activeSessionIndex] : undefined;
  const payload: LocalSavePayload = {
    baseDir: saveBaseDir,
    article: currentArticleData,
    translation: currentTranslationResult,
    session,
  };

  saveBusy = true;
  updateSaveSummary();
  setSaveStatus("保存中", "neutral");

  try {
    const settings = await getStorage(["codexHost", "codexPort", "codexToken"]);
    const host = settings.codexHost || "127.0.0.1";
    const port = settings.codexPort || 4501;
    const token = settings.codexToken || DEFAULT_PROXY_TOKEN;
    const response = await fetch(`http://${host}:${port}/local-save`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.error || `保存に失敗しました (${response.status})`);
    }
    setSaveStatus(`保存済み: ${result.baseDir}`, "success");
  } catch (error) {
    setSaveStatus(error instanceof Error ? error.message : "保存に失敗しました", "error");
  } finally {
    saveBusy = false;
    updateSaveSummary();
  }
}

savePathInput.addEventListener("change", persistSavePath);
savePathInput.addEventListener("blur", persistSavePath);

savePathResetBtn.addEventListener("click", () => {
  savePathInput.value = "~/xilot";
  persistSavePath();
  setSaveStatus("", "neutral");
});

saveOnlyToggle.addEventListener("change", () => {
  saveOnlyMode = saveOnlyToggle.checked;
  void setStorage({ xilotSaveOnlyMode: saveOnlyMode });
  updateTabLock();
  if (saveOnlyMode) switchTab("save");
});

saveCurrentBtn.addEventListener("click", () => {
  void saveCurrentArticle();
});

// --- Skeleton + Streaming ---
let streamingBuffer = "";
let streamingBlocks: ArticleBlock[] = [];
let translatedCount = 0;
let finalizedUpTo = -1;
let progressBarEl: HTMLElement | null = null;
let progressInfoEl: HTMLElement | null = null;

function renderSkeleton(blocks: ArticleBlock[]): void {
  streamingBuffer = "";
  streamingBlocks = blocks;
  translatedCount = 0;
  finalizedUpTo = -1;
  translationBlocks.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.id = "progress-wrapper";
  wrapper.innerHTML = `
    <div id="progress-bar" class="indeterminate"><div class="fill"></div></div>
    <div id="progress-info">
      <span class="label">AIが翻訳を準備中...</span>
      <span class="count"></span>
    </div>`;
  translationBlocks.appendChild(wrapper);
  progressBarEl = wrapper.querySelector(".fill")!;
  progressInfoEl = wrapper.querySelector(".count")!;

  for (const block of blocks) {
    const div = document.createElement("div");
    div.className = "skeleton-block";
    div.dataset.blockId = block.blockId;
    if (block.type === "heading") {
      div.innerHTML = '<div class="skeleton-line heading"></div>';
    } else {
      const lineCount = Math.max(1, Math.ceil(block.text.length / 40));
      for (let i = 0; i < lineCount; i++) {
        const line = document.createElement("div");
        line.className = "skeleton-line";
        if (i === lineCount - 1 && lineCount > 1) line.classList.add("short");
        else if (i % 3 === 1) line.classList.add("medium");
        else line.classList.add("full");
        div.appendChild(line);
      }
    }
    translationBlocks.appendChild(div);
  }
}

function createTranslatedElement(blockId: string, type: ArticleBlock["type"], text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "translation-block";
  div.dataset.blockId = blockId;
  switch (type) {
    case "title":
    case "heading": {
      const h2 = document.createElement("div");
      h2.className = "md-content heading";
      h2.innerHTML = renderMarkdown(`## ${text}`);
      div.appendChild(h2);
      break;
    }
    case "blockquote": {
      const bq = document.createElement("div");
      bq.className = "md-content";
      bq.innerHTML = renderMarkdown(`> ${text}`);
      div.appendChild(bq);
      break;
    }
    case "list-item": {
      const li = document.createElement("div");
      li.className = "md-content";
      li.innerHTML = renderMarkdown(`- ${text}`);
      div.appendChild(li);
      break;
    }
    default: {
      const p = document.createElement("div");
      p.className = "md-content";
      p.innerHTML = renderMarkdown(text);
      div.appendChild(p);
    }
  }
  return div;
}

function processStreamingDelta(delta: string): void {
  streamingBuffer += delta;
  const parts = streamingBuffer.split(/(?=\[\d+\])/);
  let maxSeen = -1;
  const parsed = new Map<number, string>();
  for (const part of parts) {
    const match = part.match(/^\[(\d+)\]\s*([\s\S]*)/);
    if (match) {
      const idx = parseInt(match[1], 10);
      parsed.set(idx, match[2]);
      if (idx > maxSeen) maxSeen = idx;
    }
  }
  for (let i = finalizedUpTo + 1; i < maxSeen; i++) {
    if (i >= streamingBlocks.length) break;
    const text = (parsed.get(i) ?? "").trim();
    if (!text) continue;
    replaceBlockContent(i, text);
  }
}

function replaceBlockContent(idx: number, text: string): void {
  if (idx <= finalizedUpTo) return;
  const block = streamingBlocks[idx];
  if (!block) return;
  const skeleton = translationBlocks.querySelector(`.skeleton-block[data-block-id="${block.blockId}"]`);
  if (skeleton) {
    skeleton.replaceWith(createTranslatedElement(block.blockId, block.type, text));
    translatedCount++;
    finalizedUpTo = idx;
    if (translatedCount === 1) {
      unlockScroll();
      const bar = document.getElementById("progress-bar");
      if (bar) bar.classList.remove("indeterminate");
      const label = document.querySelector("#progress-info .label");
      if (label) label.textContent = "翻訳中";
    }
    updateProgress();
  }
}

function updateProgress(): void {
  const total = streamingBlocks.length;
  const pct = Math.round((translatedCount / total) * 100);
  if (progressBarEl) progressBarEl.style.width = `${pct}%`;
  if (progressInfoEl) progressInfoEl.textContent = `${translatedCount} / ${total}`;
  if (translatedCount >= total) {
    const wrapper = document.getElementById("progress-wrapper");
    if (wrapper) {
      setTimeout(() => wrapper.remove(), 1200);
    }
  }
}

function finalizeTranslation(result: TranslationResult): void {
  currentTranslationResult = result;
  currentArticleText = result.blocks.map((b) => b.original).join("\n\n");
  for (const block of result.blocks) {
    const skeleton = translationBlocks.querySelector(`.skeleton-block[data-block-id="${block.blockId}"]`);
    if (skeleton) skeleton.replaceWith(createTranslatedElement(block.blockId, block.type, block.translated));
  }
  translatedCount = streamingBlocks.length;
  updateProgress();
  updateSaveSummary();
  if (saveOnlyMode) switchTab("save");
}

// --- Scroll sync (ratio-based, instant) ---
let userIsScrolling = false;
let userScrollTimer: ReturnType<typeof setTimeout> | null = null;
let programmaticScroll = false;

viewTranslate.addEventListener("scroll", () => {
  if (programmaticScroll) return;
  userIsScrolling = true;
  if (userScrollTimer) clearTimeout(userScrollTimer);
  userScrollTimer = setTimeout(() => { userIsScrolling = false; }, 2000);
}, { passive: true });

function syncSidepanelToRatio(ratio: number): void {
  if (userIsScrolling) return;
  const max = viewTranslate.scrollHeight - viewTranslate.clientHeight;
  if (max <= 0) return;
  programmaticScroll = true;
  viewTranslate.scrollTop = ratio * max;
  requestAnimationFrame(() => { programmaticScroll = false; });
}

function highlightBlock(blockId: string): void {
  document.querySelectorAll(".translation-block.active").forEach((el) => el.classList.remove("active"));
  if (!blockId) return;
  const target = translationBlocks.querySelector(`[data-block-id="${blockId}"]`);
  if (target) target.classList.add("active");
}

function setupReverseScroll(): void {
  let rafId = 0;
  viewTranslate.addEventListener("scroll", () => {
    if (programmaticScroll) return;
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      const max = viewTranslate.scrollHeight - viewTranslate.clientHeight;
      if (max <= 0) return;
      const ratio = viewTranslate.scrollTop / max;
      chrome.runtime.sendMessage({ type: "SIDEPANEL_SCROLL_RATIO", ratio } as any).catch(() => {});
    });
  }, { passive: true });
}

// --- Busy state (disables all chat input during processing) ---
function setBusy(busy: boolean): void {
  chatBusy = busy;
  chatSend.disabled = busy;
  chatInput.disabled = busy;
  quickActionsEl.querySelectorAll<HTMLButtonElement>(".quick-action-btn").forEach((btn) => {
    btn.disabled = busy;
    btn.style.opacity = busy ? "0.4" : "1";
    btn.style.pointerEvents = busy ? "none" : "auto";
  });
}

// --- Quick Actions ---
function initQuickActions(): void {
  quickActionsEl.innerHTML = "";
  for (const action of QUICK_ACTIONS) {
    const btn = document.createElement("button");
    btn.className = "quick-action-btn";
    btn.innerHTML = `<span class="qa-icon">${action.icon}</span>${action.label}`;
    btn.addEventListener("click", () => {
      if (chatBusy || !currentArticleText) return;
      const prompt = action.buildPrompt(currentArticleText);
      doSendChat(`${action.icon} ${action.label}`, prompt, "");
    });
    quickActionsEl.appendChild(btn);
  }
}

initQuickActions();

// --- Chat (Markdown + Image support) ---
function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}

function persistChatMessage(role: "user" | "assistant", content: string, images: SessionImage[] = []): void {
  if (activeSessionIndex < 0) return;
  const now = Date.now();
  sessions[activeSessionIndex].messages.push({
    role,
    content,
    createdAt: now,
    images,
  });
  sessions[activeSessionIndex].updatedAt = now;
  saveSessions();
  updateSaveSummary();
}

function appendSavedImages(container: HTMLElement, images: SessionImage[] = []): void {
  for (const image of images) {
    const wrapper = document.createElement("div");
    wrapper.className = "chat-image-wrapper";
    const img = document.createElement("img");
    img.src = image.base64.startsWith("data:")
      ? image.base64
      : `data:${image.mimeType || "image/png"};base64,${image.base64}`;
    wrapper.appendChild(img);

    const dlBtn = document.createElement("button");
    dlBtn.className = "image-download-btn";
    dlBtn.textContent = "保存";
    dlBtn.addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = img.src;
      a.download = `${image.id || "xilot-image"}.png`;
      a.click();
    });
    wrapper.appendChild(dlBtn);
    container.appendChild(wrapper);

    if (image.revisedPrompt) {
      const caption = document.createElement("p");
      caption.className = "image-caption";
      caption.textContent = image.revisedPrompt;
      container.appendChild(caption);
    }
  }
}

function appendChatBubble(role: "user" | "assistant", content: string, save: boolean, images: SessionImage[] = []): HTMLElement {
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  if (role === "assistant") {
    div.innerHTML = renderMarkdown(content);
    div.querySelectorAll("img").forEach((img) => addImageDownload(img));
    appendSavedImages(div, images);
  } else {
    div.textContent = content;
  }
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (save && activeSessionIndex >= 0) {
    persistChatMessage(role, content, images);
  }
  return div;
}

function addImageDownload(img: HTMLImageElement): void {
  const wrapper = document.createElement("div");
  wrapper.className = "chat-image-wrapper";
  img.parentElement?.insertBefore(wrapper, img);
  wrapper.appendChild(img);

  const dlBtn = document.createElement("button");
  dlBtn.className = "image-download-btn";
  dlBtn.textContent = "⬇ 保存";
  dlBtn.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = img.src;
    a.download = `xilot-${Date.now()}.png`;
    a.click();
  });
  wrapper.appendChild(dlBtn);
}

function startAssistantBubble(): HTMLElement {
  const div = document.createElement("div");
  div.className = "chat-msg assistant";
  div.innerHTML = '<div class="thinking-indicator"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function doSendChat(displayText: string, prompt: string, articleContext: string): void {
  if (chatBusy || saveOnlyMode) return;
  setBusy(true);
  pendingAssistantImages = [];

  appendChatBubble("user", displayText, true);
  activeChatBubble = startAssistantBubble();

  chrome.runtime.sendMessage({
    type: "CHAT_SEND",
    text: prompt,
    articleContext,
  } satisfies MessageType);
}

async function sendChatMessage(): Promise<void> {
  const text = chatInput.value.trim();
  if (!text || chatBusy) return;
  chatInput.value = "";
  chatInput.style.height = "auto";
  doSendChat(text, text, currentArticleText);
}

chatSend.addEventListener("click", sendChatMessage);

let isComposing = false;
chatInput.addEventListener("compositionstart", () => { isComposing = true; });
chatInput.addEventListener("compositionend", () => { isComposing = false; });

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !isComposing && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
});

// --- Content Script injection ---
async function injectContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  await new Promise((r) => setTimeout(r, 50));
}

async function sendToContentScript(tabId: number): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_ARTICLE" } satisfies MessageType);
  } catch {
    await injectContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_ARTICLE" } satisfies MessageType);
  }
}

// --- Start ---
async function startTranslation(): Promise<void> {
  await Promise.all([sessionsReady, saveSettingsReady]);
  currentArticleUrl = "";
  currentArticleText = "";
  currentArticleData = null;
  currentTranslationResult = null;
  updateSaveSummary();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { errorMessage.textContent = "アクティブなタブが見つかりません。"; showState("error"); return; }

  try {
    const response = await sendToContentScript(tab.id) as { type: string; data?: ArticleData };
    if (response?.type === "ARTICLE_DATA" && response.data) {
      showState("translating");
      currentArticleUrl = response.data.url;
      currentArticleData = response.data;
      currentTranslationResult = null;
      currentArticleText = response.data.blocks.map((b) => b.text).join("\n\n");
      setSaveStatus("", "neutral");
      updateSaveSummary();
      articleMeta.innerHTML = response.data.author
        ? `<div class="author">${response.data.author}</div>`
        : "";
      renderSkeleton(response.data.blocks);

      getOrCreateSession(currentArticleUrl, response.data.title);
      renderSessionHistory();
      updateSessionTitle();

      chrome.runtime.sendMessage({ type: "TRANSLATE_REQUEST", data: response.data } satisfies MessageType);
    } else {
      errorMessage.textContent = "Xの記事または投稿が見つかりません。対象ページを開いてください。";
      showState("error");
    }
  } catch {
    errorMessage.textContent = "ページとの通信に失敗しました。ページをリロードしてください。";
    showState("error");
  }
}

// --- Message Handling ---
let streamingText = "";

chrome.runtime.onMessage.addListener((message: MessageType & { block?: TranslatedBlock; progress?: number; total?: number }) => {
  switch (message.type) {
    case "TRANSLATION_CHUNK_DONE":
      if (message.block) {
        const skeleton = translationBlocks.querySelector(`.skeleton-block[data-block-id="${message.block.blockId}"]`);
        if (skeleton) {
          skeleton.replaceWith(createTranslatedElement(message.block.blockId, message.block.type, message.block.translated));
          translatedCount++;
          if (translatedCount === 1) unlockScroll();
        }
        if (message.progress != null && message.total) {
          const pct = Math.round((message.progress / message.total) * 100);
          if (progressBarEl) progressBarEl.style.width = `${pct}%`;
          if (progressInfoEl) progressInfoEl.textContent = `${message.progress} / ${message.total}`;
          const bar = document.getElementById("progress-bar");
          if (bar?.classList.contains("indeterminate")) {
            bar.classList.remove("indeterminate");
            const label = document.querySelector("#progress-info .label");
            if (label) label.textContent = "翻訳中";
          }
          if (message.progress >= message.total) {
            const wrapper = document.getElementById("progress-wrapper");
            if (wrapper) setTimeout(() => wrapper.remove(), 1200);
          }
        }
      }
      break;
    case "TRANSLATION_DELTA":
      processStreamingDelta(message.delta);
      break;
    case "TRANSLATION_RESULT":
      finalizeTranslation(message.data);
      setupReverseScroll();
      break;
    case "TRANSLATION_ERROR":
      errorMessage.textContent = message.error;
      showState("error");
      break;
    case "SCROLL_RATIO":
      syncSidepanelToRatio(message.ratio);
      highlightBlock(message.blockId);
      break;
    case "HOVER_BLOCK":
      highlightBlock(message.blockId);
      break;
    case "CHAT_DELTA":
      if (activeChatBubble) {
        if (activeChatBubble.querySelector(".thinking-indicator")) {
          activeChatBubble.innerHTML = "";
          streamingText = "";
        }
        streamingText += message.delta;
        activeChatBubble.innerHTML = renderMarkdown(streamingText);
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    case "CHAT_PROCESSING":
      if (activeChatBubble && !activeChatBubble.querySelector(".thinking-indicator")) {
        const dots = document.createElement("div");
        dots.className = "thinking-indicator";
        dots.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
        activeChatBubble.appendChild(dots);
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    case "IMAGE_GENERATING": {
      const existing = chatMessages.querySelector(".image-gen-bubble");
      if (!existing) {
        const bubble = document.createElement("div");
        bubble.className = "chat-msg assistant image-gen-bubble";
        bubble.innerHTML = `
          <div class="image-gen-status">
            <div class="image-gen-spinner"></div>
            <span>画像を生成中...</span>
          </div>
          <div class="image-gen-hint">通常10〜20秒かかります</div>`;
        chatMessages.appendChild(bubble);
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    }
    case "IMAGE_COMPLETE": {
      const genBubble = chatMessages.querySelector(".image-gen-bubble");
      if (genBubble) genBubble.remove();

      const sessionImage: SessionImage = {
        id: makeId("image"),
        base64: message.base64,
        revisedPrompt: message.revisedPrompt || "",
        mimeType: "image/png",
        createdAt: Date.now(),
      };
      pendingAssistantImages.push(sessionImage);

      const imgBubble = document.createElement("div");
      imgBubble.className = "chat-msg assistant";
      appendSavedImages(imgBubble, [sessionImage]);
      chatMessages.appendChild(imgBubble);
      chatMessages.scrollTop = chatMessages.scrollHeight;
      updateSaveSummary();
      break;
    }
    case "CHAT_COMPLETE":
      if (activeChatBubble) {
        const finalContent = streamingText || message.text;
        if (finalContent.trim()) {
          activeChatBubble.innerHTML = renderMarkdown(finalContent);
          activeChatBubble.querySelectorAll("img").forEach((img) => addImageDownload(img as HTMLImageElement));
        } else {
          activeChatBubble.remove();
        }
        activeChatBubble = null;

        if (activeSessionIndex >= 0 && (finalContent.trim() || pendingAssistantImages.length > 0)) {
          const safeContent = finalContent.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[画像]");
          persistChatMessage("assistant", safeContent, pendingAssistantImages);
        }
        pendingAssistantImages = [];
        streamingText = "";
      }
      setBusy(false);
      chatInput.focus();
      break;
    case "CHAT_ERROR":
      if (activeChatBubble) {
        activeChatBubble.textContent = `エラー: ${message.error}`;
        activeChatBubble.classList.add("error");
        activeChatBubble = null;
      }
      pendingAssistantImages = [];
      setBusy(false);
      break;
  }
});

retryBtn.addEventListener("click", () => startTranslation());
startTranslation();
