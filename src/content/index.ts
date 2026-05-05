import { extractArticle, isArticlePage, observeArticleChanges } from "./extractor";
import { cleanupScrollSync, scrollToBlock, setupScrollSync } from "./scroll-sync";
import type { MessageType } from "../lib/types";

let lastUrl = location.href;

function isArticleUrl(): boolean {
  return /x\.com\/[^/]+\/(status|article)\//.test(location.href);
}

function handleArticleDetected(): void {
  if (!isArticleUrl() || !isArticlePage()) return;
  setupScrollSync();
}

function checkUrlChange(): void {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    cleanupScrollSync();
    setTimeout(() => handleArticleDetected(), 1000);
  }
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
  },
);

observeArticleChanges(handleArticleDetected);
setInterval(checkUrlChange, 500);

if (isArticlePage()) {
  handleArticleDetected();
}
