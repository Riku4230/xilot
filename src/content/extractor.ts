import type { ArticleBlock, ArticleData } from "../lib/types";

const SELECTORS = {
  articleTitle: '[data-testid="twitter-article-title"]',
  tweetContainer: '[data-testid="tweet"]',
  tweetText: '[data-testid="tweetText"]',
  tweetPhoto: '[data-testid="tweetPhoto"]',
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
  return document.querySelector(SELECTORS.articleTitle) !== null || findPrimaryTweet() !== null;
}

export function extractArticle(): ArticleData | null {
  const titleEl = document.querySelector(SELECTORS.articleTitle);
  if (!titleEl) return extractPost();

  const title = titleEl.textContent?.trim() ?? "";

  const userNameEl = document.querySelector(SELECTORS.userName);
  const author = userNameEl?.textContent?.trim() ?? "";

  const timeEl = document.querySelector(SELECTORS.time);
  const timestamp = timeEl?.getAttribute("datetime") ?? "";

  const contentBlocks = document.querySelectorAll(SELECTORS.contentBlock);
  const seenOffsetKeys = new Set<string>();
  const blocks: ArticleBlock[] = [];

  if (title) {
    blocks.push({ blockId: "block-title", type: "title", text: title });
  }

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
    kind: "article",
    url: location.href,
    canonicalUrl: location.href,
    title,
    author,
    timestamp,
    blocks,
    links: [{ url: location.href, text: "Article" }],
    media: [],
  };
}

function getStatusId(): string {
  return location.pathname.match(/\/status\/(\d+)/)?.[1] ?? "";
}

function findPrimaryTweet(): Element | null {
  const statusId = getStatusId();
  const tweets = Array.from(document.querySelectorAll(SELECTORS.tweetContainer));
  if (tweets.length === 0) return null;
  if (!statusId) return tweets[0];

  return tweets.find((tweet) => {
    const links = Array.from(tweet.querySelectorAll<HTMLAnchorElement>("a[href]"));
    return links.some((link) => link.href.includes(`/status/${statusId}`));
  }) ?? tweets[0];
}

function extractPostText(tweet: Element): string {
  const textEl = tweet.querySelector(SELECTORS.tweetText);
  if (!textEl) return "";

  const spans = textEl.querySelectorAll(SELECTORS.textSpan);
  if (spans.length > 0) {
    return Array.from(spans)
      .map((span) => span.textContent ?? "")
      .join("")
      .trim();
  }
  return textEl.textContent?.trim() ?? "";
}

function extractAuthor(tweet: Element): string {
  const userNameEl = tweet.querySelector(SELECTORS.userName);
  return userNameEl?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizeTweetImageUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname === "pbs.twimg.com" && url.pathname.startsWith("/media/")) {
      url.searchParams.set("name", "large");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function extractMedia(tweet: Element): NonNullable<ArticleData["media"]> {
  const urls = new Set<string>();
  const media: NonNullable<ArticleData["media"]> = [];
  tweet.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media/"]').forEach((img) => {
    const url = normalizeTweetImageUrl(img.src);
    if (urls.has(url)) return;
    urls.add(url);
    media.push({
      type: "image",
      url,
      alt: img.alt || "",
    });
  });
  return media;
}

function extractLinks(root: ParentNode, canonicalUrl = ""): ArticleData["links"] {
  const seen = new Set<string>();
  const links: NonNullable<ArticleData["links"]> = [];

  if (canonicalUrl) {
    seen.add(canonicalUrl);
    links.push({ url: canonicalUrl, text: "Post" });
  }

  root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    const href = anchor.href;
    if (!href || seen.has(href)) return;
    if (href.startsWith("javascript:")) return;
    if (href.includes("/photo/")) return;
    if (href.includes("/analytics")) return;
    if (href.includes("/status/") && canonicalUrl && href !== canonicalUrl) return;

    const text = anchor.textContent?.replace(/\s+/g, " ").trim() || href;
    seen.add(href);
    links.push({ url: href, text });
  });

  return links;
}

function buildPostTitle(text: string, author: string): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  if (firstLine) return firstLine.length > 72 ? `${firstLine.slice(0, 72)}...` : firstLine;
  return author ? `Post by ${author}` : "X Post";
}

function extractPost(): ArticleData | null {
  const tweet = findPrimaryTweet();
  if (!tweet) return null;

  const text = extractPostText(tweet);
  const author = extractAuthor(tweet);
  const timeEl = tweet.querySelector(SELECTORS.time);
  const timestamp = timeEl?.getAttribute("datetime") ?? "";
  const statusId = getStatusId();
  const canonicalUrl = statusId ? `${location.origin}${location.pathname.match(/^\/[^/]+\/status\/\d+/)?.[0] ?? location.pathname}` : location.href;
  const title = buildPostTitle(text, author);
  const media = extractMedia(tweet);
  const links = extractLinks(tweet.querySelector(SELECTORS.tweetText) ?? tweet, canonicalUrl);
  const blocks: ArticleBlock[] = [];

  if (title) {
    blocks.push({ blockId: "block-title", type: "title", text: title });
  }
  if (text) {
    blocks.push({ blockId: "block-post-text", type: "paragraph", text });
  }

  if (blocks.length === 0 && media.length === 0) return null;

  return {
    kind: "post",
    url: location.href,
    canonicalUrl,
    title,
    author,
    timestamp,
    blocks,
    links,
    media,
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
