import { extractArticle, isArticlePage, observeArticleChanges } from "./extractor";
import { cleanupScrollSync, scrollToBlock, scrollToRatio, setupScrollSync } from "./scroll-sync";
import type { MessageType } from "../lib/types";

let lastUrl = location.href;
let urlCheckInterval: ReturnType<typeof setInterval> | null = null;
let mutationObserver: MutationObserver | null = null;

function isContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    shutdown();
    return false;
  }
}

function isArticleUrl(): boolean {
  return /x\.com\/[^/]+\/(status|article)\//.test(location.href);
}

function handleArticleDetected(): void {
  if (!isContextValid()) return;
  if (!isArticleUrl() || !isArticlePage()) return;
  setupScrollSync();
}

function checkUrlChange(): void {
  if (!isContextValid()) return;
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    cleanupScrollSync();
    setTimeout(() => handleArticleDetected(), 1000);
  }
}

function shutdown(): void {
  if (urlCheckInterval) { clearInterval(urlCheckInterval); urlCheckInterval = null; }
  if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }
  cleanupScrollSync();
}

chrome.runtime.onMessage.addListener(
  (message: MessageType, _sender, sendResponse) => {
    if (message.type === "EXTRACT_ARTICLE") {
      const data = extractArticle();
      if (data) {
        sendResponse({ type: "ARTICLE_DATA", data });
      } else {
        sendResponse({ type: "ARTICLE_NOT_FOUND" });
      }
      return true;
    }

    if (message.type === "SCROLL_TO_BLOCK") {
      scrollToBlock(message.blockId);
    }

    if ((message as any).type === "SCROLL_TO_RATIO") {
      scrollToRatio((message as any).ratio);
    }
  },
);

mutationObserver = observeArticleChanges(handleArticleDetected);
urlCheckInterval = setInterval(checkUrlChange, 500);

if (isArticlePage()) {
  handleArticleDetected();
}
