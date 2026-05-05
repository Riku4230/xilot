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

// --- Tab Switching ---
function switchTab(tab: "translate" | "chat"): void {
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
}

function unlockScroll(): void {
  isTranslating = false;
  viewTranslate.style.overflowY = "auto";
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

  const progressBar = document.createElement("div");
  progressBar.id = "progress-bar";
  progressBar.innerHTML = '<div class="fill" style="width: 0%"></div>';
  translationBlocks.appendChild(progressBar);
  progressBarEl = progressBar.querySelector(".fill")!;

  const progressInfo = document.createElement("div");
  progressInfo.id = "progress-info";
  progressInfo.textContent = `翻訳中... 0/${blocks.length}`;
  translationBlocks.appendChild(progressInfo);
  progressInfoEl = progressInfo;

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
  if (progressInfoEl) {
    if (translatedCount >= total) {
      progressInfoEl.textContent = "翻訳完了";
      setTimeout(() => { progressBarEl?.parentElement?.remove(); progressInfoEl?.remove(); }, 1500);
    } else {
      progressInfoEl.textContent = `翻訳中... ${translatedCount}/${total}`;
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
        activeChatBubble.innerHTML = `
          <div class="image-gen-status">
            <div class="image-gen-spinner"></div>
            <span>画像を生成中...</span>
          </div>`;
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    case "IMAGE_COMPLETE": {
      const imgHtml = `\n\n![生成画像](data:image/png;base64,${message.base64})\n\n`;
      streamingText += imgHtml;
      if (activeChatBubble) {
        activeChatBubble.innerHTML = renderMarkdown(streamingText);
        activeChatBubble.querySelectorAll("img").forEach((img) => addImageDownload(img as HTMLImageElement));
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
          sessions[activeSessionIndex].messages.push({ role: "assistant", content: finalContent });
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
