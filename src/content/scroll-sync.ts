const SELECTORS = {
  contentBlock: '[class*="longform-"]',
} as const;

let hoverListeners: Array<{ el: Element; enter: () => void; leave: () => void }> = [];
let scrollHandler: (() => void) | null = null;
let scrollRafId = 0;
let lastReportedBlockId = "";

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

  scrollHandler = () => {
    cancelAnimationFrame(scrollRafId);
    scrollRafId = requestAnimationFrame(() => {
      if (!isContextValid()) return;

      const allBlocks = document.querySelectorAll(`[data-translate-block-id]`);
      let closestId = "";
      let closestDist = Infinity;

      for (const block of allBlocks) {
        const rect = block.getBoundingClientRect();
        const dist = Math.abs(rect.top - 80);
        if (dist < closestDist) {
          closestDist = dist;
          closestId = (block as HTMLElement).dataset.translateBlockId || "";
        }
      }

      if (closestId && closestId !== lastReportedBlockId) {
        lastReportedBlockId = closestId;
        chrome.runtime.sendMessage({ type: "SCROLL_SYNC", blockId: closestId }).catch(() => cleanup());
      }
    });
  };

  window.addEventListener("scroll", scrollHandler, { passive: true });
}

export function scrollToBlock(blockId: string): void {
  const block = document.querySelector(`[data-translate-block-id="${blockId}"]`);
  if (block) {
    block.scrollIntoView({ behavior: "smooth", block: "start" });
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
  lastReportedBlockId = "";
}

export { cleanup as cleanupScrollSync };
