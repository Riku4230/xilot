import type { ArticleBlock, ArticleData, MessageType, TranslatedBlock, TranslationResult } from "../lib/types";
import { QUICK_ACTIONS } from "../lib/prompts";
import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });

// --- Elements ---
const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
const viewTranslate = document.getElementById("view-translate")!;
const viewChat = document.getElementById("view-chat")!;

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

// --- State ---
let currentArticleUrl = "";
let currentArticleText = "";
let activeChatBubble: HTMLElement | null = null;
let chatBusy = false;

// --- Session Management ---
interface ChatMessage { role: "user" | "assistant"; content: string }
interface ChatSession { articleUrl: string; articleTitle: string; messages: ChatMessage[]; createdAt: number }

let sessions: ChatSession[] = [];
let activeSessionIndex = -1;

function loadSessions(): void {
  chrome.storage.local.get(["xilotSessions"], (result) => {
    sessions = result.xilotSessions || [];
  });
}

function saveSessions(): void {
  chrome.storage.local.set({ xilotSessions: sessions });
}

function getOrCreateSession(url: string, title: string): ChatSession {
  let idx = sessions.findIndex((s) => s.articleUrl === url);
  if (idx === -1) {
    sessions.unshift({ articleUrl: url, articleTitle: title, messages: [], createdAt: Date.now() });
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
    appendChatBubble(msg.role, msg.content, false);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

loadSessions();

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
  sessions.unshift({
    articleUrl: currentArticleUrl,
    articleTitle: sessions[activeSessionIndex]?.articleTitle || "新規チャット",
    messages: [],
    createdAt: Date.now(),
  });
  activeSessionIndex = 0;
  saveSessions();
  chatMessages.innerHTML = "";
  updateSessionTitle();
  sessionListEl.classList.add("hidden");
  chatInput.focus();
});

// --- Tab Switching ---
function updateTabLock(): void {
  const chatTab = document.querySelector('.tab[data-tab="chat"]') as HTMLButtonElement;
  if (chatTab) {
    chatTab.disabled = isTranslating;
    chatTab.style.opacity = isTranslating ? "0.4" : "1";
    chatTab.style.cursor = isTranslating ? "not-allowed" : "pointer";
  }
}

function switchTab(tab: "translate" | "chat"): void {
  if (tab === "chat" && isTranslating) return;
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  viewTranslate.classList.toggle("hidden", tab !== "translate");
  viewChat.classList.toggle("hidden", tab !== "chat");
  if (tab === "chat") {
    chatInput.focus();
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab as "translate" | "chat"));
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
}

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
    <div id="progress-bar"><div class="fill" style="width: 0%"></div></div>
    <div id="progress-info">
      <span class="label">翻訳中</span>
      <span class="count">0 / ${blocks.length}</span>
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
    if (translatedCount === 1) unlockScroll();
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
  currentArticleText = result.blocks.map((b) => b.original).join("\n\n");
  for (const block of result.blocks) {
    const skeleton = translationBlocks.querySelector(`.skeleton-block[data-block-id="${block.blockId}"]`);
    if (skeleton) skeleton.replaceWith(createTranslatedElement(block.blockId, block.type, block.translated));
  }
  translatedCount = streamingBlocks.length;
  updateProgress();
}

// --- Scroll sync (block-based) ---
let userIsScrolling = false;
let userScrollTimer: ReturnType<typeof setTimeout> | null = null;
let programmaticScroll = false;

viewTranslate.addEventListener("scroll", () => {
  if (programmaticScroll) return;
  userIsScrolling = true;
  if (userScrollTimer) clearTimeout(userScrollTimer);
  userScrollTimer = setTimeout(() => { userIsScrolling = false; }, 3000);
}, { passive: true });

function scrollSidepanelToBlock(blockId: string): void {
  if (userIsScrolling) return;
  const target = translationBlocks.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
  if (!target) return;
  programmaticScroll = true;
  viewTranslate.scrollTo({ top: target.offsetTop - 20, behavior: "smooth" });
  setTimeout(() => { programmaticScroll = false; }, 500);
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
      const blocks = viewTranslate.querySelectorAll(".translation-block");
      const scrollTop = viewTranslate.scrollTop + 20;
      let closest: HTMLElement | null = null;
      let closestDist = Infinity;
      for (const block of blocks) {
        const el = block as HTMLElement;
        const dist = Math.abs(el.offsetTop - scrollTop);
        if (dist < closestDist) { closestDist = dist; closest = el; }
      }
      if (closest?.dataset.blockId) {
        chrome.runtime.sendMessage({ type: "SIDEPANEL_SCROLL", blockId: closest.dataset.blockId } as any).catch(() => {});
      }
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

function appendChatBubble(role: "user" | "assistant", content: string, save: boolean): HTMLElement {
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  if (role === "assistant") {
    div.innerHTML = renderMarkdown(content);
    div.querySelectorAll("img").forEach((img) => addImageDownload(img));
  } else {
    div.textContent = content;
  }
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (save && activeSessionIndex >= 0) {
    sessions[activeSessionIndex].messages.push({ role, content });
    saveSessions();
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
  div.innerHTML = '<span class="typing-dots">考え中</span>';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function doSendChat(displayText: string, prompt: string, articleContext: string): void {
  if (chatBusy) return;
  setBusy(true);

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
  await new Promise((r) => setTimeout(r, 300));
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { errorMessage.textContent = "アクティブなタブが見つかりません。"; showState("error"); return; }

  try {
    const response = await sendToContentScript(tab.id) as { type: string; data?: ArticleData };
    if (response?.type === "ARTICLE_DATA" && response.data) {
      showState("translating");
      currentArticleUrl = response.data.url;
      currentArticleText = response.data.blocks.map((b) => b.text).join("\n\n");
      articleMeta.innerHTML = `<div class="author">${response.data.author}</div>`;
      renderSkeleton(response.data.blocks);

      getOrCreateSession(currentArticleUrl, response.data.title);
      renderSessionHistory();
      updateSessionTitle();

      chrome.runtime.sendMessage({ type: "TRANSLATE_REQUEST", data: response.data } satisfies MessageType);
    } else {
      errorMessage.textContent = "X記事が見つかりません。記事ページを開いてください。";
      showState("error");
    }
  } catch {
    errorMessage.textContent = "ページとの通信に失敗しました。ページをリロードしてください。";
    showState("error");
  }
}

// --- Message Handling ---
let streamingText = "";

chrome.runtime.onMessage.addListener((message: MessageType) => {
  switch (message.type) {
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
    case "SCROLL_SYNC":
      scrollSidepanelToBlock(message.blockId);
      highlightBlock(message.blockId);
      break;
    case "HOVER_BLOCK":
      highlightBlock(message.blockId);
      break;
    case "CHAT_DELTA":
      if (activeChatBubble) {
        if (activeChatBubble.querySelector(".typing-dots")) {
          activeChatBubble.innerHTML = "";
          streamingText = "";
        }
        streamingText += message.delta;
        activeChatBubble.innerHTML = renderMarkdown(streamingText);
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    case "IMAGE_GENERATING":
      if (activeChatBubble) {
        const existing = activeChatBubble.querySelector(".image-gen-status");
        if (!existing) {
          const status = document.createElement("div");
          status.className = "image-gen-status";
          status.innerHTML = '<div class="image-gen-spinner"></div><span>画像を生成中...</span>';
          activeChatBubble.appendChild(status);
        }
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    case "IMAGE_COMPLETE": {
      if (activeChatBubble) {
        const spinner = activeChatBubble.querySelector(".image-gen-status");
        if (spinner) spinner.remove();

        const wrapper = document.createElement("div");
        wrapper.className = "chat-image-wrapper";
        const img = document.createElement("img");
        img.src = `data:image/png;base64,${message.base64}`;
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
        activeChatBubble.appendChild(wrapper);
        streamingText += `\n\n[画像生成済み]\n\n`;
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    }
    case "CHAT_COMPLETE":
      if (activeChatBubble) {
        const finalContent = streamingText || message.text;
        activeChatBubble.innerHTML = renderMarkdown(finalContent);
        activeChatBubble.querySelectorAll("img").forEach((img) => addImageDownload(img as HTMLImageElement));
        activeChatBubble = null;

        if (activeSessionIndex >= 0) {
          const safeContent = finalContent.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[画像]");
          sessions[activeSessionIndex].messages.push({ role: "assistant", content: safeContent });
          saveSessions();
        }
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
      setBusy(false);
      break;
  }
});

retryBtn.addEventListener("click", () => startTranslation());
startTranslation();
