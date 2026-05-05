import type { ArticleBlock, ArticleData } from "../lib/types";

const SELECTORS = {
  articleTitle: '[data-testid="twitter-article-title"]',
  tweetContainer: '[data-testid="tweet"]',
  userName: '[data-testid="User-Name"]',
  contentBlock: '[class*="longform-"]',
  textSpan: 'span[data-text="true"]',
  time: "time",
} as const;

function detectBlockType(element: Element): ArticleBlock["type"] {
  const className = element.className;
  if (className.includes("longform-header")) return "heading";
  if (className.includes("longform-blockquote")) return "blockquote";
  if (className.includes("longform-list-item")) return "list-item";
  if (className.includes("longform-code")) return "code";
  if (className.includes("longform-unstyled")) return "paragraph";
  return "paragraph";
}

function extractTextFromBlock(block: Element): string {
  const spans = block.querySelectorAll(SELECTORS.textSpan);
  if (spans.length > 0) {
    return Array.from(spans)
      .map((span) => span.textContent ?? "")
      .join("");
  }
  return block.textContent?.trim() ?? "";
}

export function isArticlePage(): boolean {
  return document.querySelector(SELECTORS.articleTitle) !== null;
}

export function extractArticle(): ArticleData | null {
  const titleEl = document.querySelector(SELECTORS.articleTitle);
  if (!titleEl) return null;

  const title = titleEl.textContent?.trim() ?? "";

  const userNameEl = document.querySelector(SELECTORS.userName);
  const author = userNameEl?.textContent?.trim() ?? "";

  const timeEl = document.querySelector(SELECTORS.time);
  const timestamp = timeEl?.getAttribute("datetime") ?? "";

  const contentBlocks = document.querySelectorAll(SELECTORS.contentBlock);
  const seenOffsetKeys = new Set<string>();
  const blocks: ArticleBlock[] = [];

  contentBlocks.forEach((block, index) => {
    const offsetKey = block.getAttribute("data-offset-key") ?? "";
    if (offsetKey && seenOffsetKeys.has(offsetKey)) return;
    if (offsetKey) seenOffsetKeys.add(offsetKey);

    const text = extractTextFromBlock(block);
    if (!text) return;

    blocks.push({
      blockId: `block-${index}`,
      type: detectBlockType(block),
      text,
      offsetKey: offsetKey || undefined,
    });
  });

  if (blocks.length === 0) return null;

  return {
    url: location.href,
    title,
    author,
    timestamp,
    blocks,
  };
}

export function observeArticleChanges(callback: () => void): MutationObserver {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
        if (isArticlePage()) {
          callback();
          break;
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  return observer;
}
