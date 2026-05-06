const SELECTORS = {
  contentBlock: '[class*="longform-"]',
} as const;

let hoverListeners: Array<{ el: Element; enter: () => void; leave: () => void }> = [];
let scrollHandler: (() => void) | null = null;
let scrollRafId = 0;
let programmaticScroll = false;

function isContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    cleanup();
    return false;
  }
}

export function setupScrollSync(): void {
  cleanup();

  const blocks = document.querySelectorAll(SELECTORS.contentBlock);
  if (blocks.length === 0) return;

  blocks.forEach((block, index) => {
    const blockId = `block-${index}`;
    (block as HTMLElement).dataset.translateBlockId = blockId;

    const enter = () => {
      if (!isContextValid()) return;
      chrome.runtime.sendMessage({ type: "HOVER_BLOCK", blockId }).catch(() => {});
    };
    const leave = () => {
      if (!isContextValid()) return;
      chrome.runtime.sendMessage({ type: "HOVER_BLOCK", blockId: "" }).catch(() => {});
    };
    block.addEventListener("mouseenter", enter);
    block.addEventListener("mouseleave", leave);
    hoverListeners.push({ el: block, enter, leave });
  });

  const articleContainer = document.querySelector('[data-testid="tweet"]')?.closest('[class*="css-"]') as HTMLElement | null;
  const getScrollRatio = () => {
    const scrollEl = document.scrollingElement || document.documentElement;
    const max = scrollEl.scrollHeight - scrollEl.clientHeight;
    return max > 0 ? scrollEl.scrollTop / max : 0;
  };

  scrollHandler = () => {
    if (programmaticScroll) return;
    cancelAnimationFrame(scrollRafId);
    scrollRafId = requestAnimationFrame(() => {
      if (!isContextValid()) return;
      chrome.runtime.sendMessage({ type: "SCROLL_RATIO", ratio: getScrollRatio() }).catch(() => cleanup());
    });
  };

  window.addEventListener("scroll", scrollHandler, { passive: true });
}

export function scrollToRatio(ratio: number): void {
  programmaticScroll = true;
  const scrollEl = document.scrollingElement || document.documentElement;
  const max = scrollEl.scrollHeight - scrollEl.clientHeight;
  scrollEl.scrollTop = ratio * max;
  requestAnimationFrame(() => { programmaticScroll = false; });
}

export function scrollToBlock(blockId: string): void {
  const block = document.querySelector(`[data-translate-block-id="${blockId}"]`);
  if (block) {
    programmaticScroll = true;
    block.scrollIntoView({ behavior: "auto", block: "start" });
    requestAnimationFrame(() => { programmaticScroll = false; });
  }
}

function cleanup(): void {
  if (scrollHandler) {
    window.removeEventListener("scroll", scrollHandler);
    scrollHandler = null;
  }
  for (const { el, enter, leave } of hoverListeners) {
    el.removeEventListener("mouseenter", enter);
    el.removeEventListener("mouseleave", leave);
  }
  hoverListeners = [];
}

export { cleanup as cleanupScrollSync };
