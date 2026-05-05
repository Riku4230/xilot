import { CodexClient } from "../lib/codex-client";
import type { ArticleData, MessageType, TranslatedBlock, TranslationResult } from "../lib/types";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const DEFAULT_PROXY_TOKEN = "5f81c308b8f816ca72e3990e2cf77543";
const CHUNK_SIZE = 10;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["codexToken"], (result) => {
    if (!result.codexToken) {
      chrome.storage.local.set({ codexToken: DEFAULT_PROXY_TOKEN });
    }
  });
});

// --- Pre-warm connection on startup ---
let codex: CodexClient | null = null;
let currentArticleText = "";
let warmupPromise: Promise<CodexClient> | null = null;

function warmup(): Promise<CodexClient> {
  if (!warmupPromise) {
    warmupPromise = (async () => {
      const settings = await chrome.storage.local.get(["codexHost", "codexPort", "codexToken"]);
      const host = settings.codexHost || "127.0.0.1";
      const port = settings.codexPort || 4501;
      const token = settings.codexToken || "";
      codex = new CodexClient({ host, port, token });
      await codex.connect();
      console.log("[Xilot] Pre-warm connected");
      return codex;
    })().catch((e) => {
      console.log("[Xilot] Pre-warm failed:", e);
      warmupPromise = null;
      throw e;
    });
  }
  return warmupPromise;
}

warmup();

async function ensureConnected(): Promise<CodexClient> {
  if (codex?.isConnected()) return codex;
  warmupPromise = null;
  return warmup();
}

function broadcast(msg: MessageType): void {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// --- Chunk-based parallel translation ---
async function translateArticle(data: ArticleData): Promise<void> {
  let client: CodexClient;
  try {
    client = await ensureConnected();
  } catch (e) {
    broadcast({
      type: "TRANSLATION_ERROR",
      error: `Codex app-serverに接続できません: ${e instanceof Error ? e.message : String(e)}`,
    });
    return;
  }

  currentArticleText = data.blocks.map((b) => b.text).join("\n\n");

  const chunks: ArticleData["blocks"][] = [];
  for (let i = 0; i < data.blocks.length; i += CHUNK_SIZE) {
    chunks.push(data.blocks.slice(i, i + CHUNK_SIZE));
  }

  const allTranslated: TranslatedBlock[] = new Array(data.blocks.length);
  let completedBlocks = 0;

  const translateChunk = async (chunk: ArticleData["blocks"][], chunkIndex: number) => {
    const globalOffset = chunkIndex * CHUNK_SIZE;
    const prompt = `以下の英語テキストを日本語に翻訳してください。各項目を番号付きで出力してください。

${chunk.map((b, i) => `[${i}] ${b.text}`).join("\n\n")}

出力形式:
[0] 翻訳文
[1] 翻訳文
...`;

    try {
      const response = await client.sendMessage(prompt);
      const parsed = parseChunkResponse(response, chunk);

      for (let i = 0; i < parsed.length; i++) {
        const globalIdx = globalOffset + i;
        if (globalIdx < data.blocks.length) {
          allTranslated[globalIdx] = parsed[i];
          completedBlocks++;
          broadcast({
            type: "TRANSLATION_CHUNK_DONE",
            block: parsed[i],
            progress: completedBlocks,
            total: data.blocks.length,
          } as any);
        }
      }
    } catch (error) {
      for (let i = 0; i < chunk.length; i++) {
        const globalIdx = globalOffset + i;
        if (globalIdx < data.blocks.length) {
          const b = data.blocks[globalIdx];
          allTranslated[globalIdx] = {
            blockId: b.blockId,
            type: b.type,
            original: b.text,
            translated: b.text,
          };
          completedBlocks++;
        }
      }
    }
  };

  try {
    for (let idx = 0; idx < chunks.length; idx++) {
      await translateChunk([chunks[idx]], idx);
    }

    broadcast({
      type: "TRANSLATION_RESULT",
      data: {
        url: data.url,
        title: data.title,
        author: data.author,
        blocks: allTranslated.filter(Boolean),
      },
    });
  } catch (error) {
    broadcast({
      type: "TRANSLATION_ERROR",
      error: error instanceof Error ? error.message : "翻訳中にエラーが発生しました",
    });
  }
}

function parseChunkResponse(response: string, blocks: ArticleData["blocks"][]): TranslatedBlock[] {
  const flat = blocks.flat();
  const lines = response.split("\n");
  const translations = new Map<number, string>();
  let currentIndex = -1;
  let currentText = "";

  for (const line of lines) {
    const match = line.match(/^\[(\d+)\]\s*(.*)/);
    if (match) {
      if (currentIndex >= 0) translations.set(currentIndex, currentText.trim());
      currentIndex = parseInt(match[1], 10);
      currentText = match[2];
    } else if (currentIndex >= 0) {
      currentText += "\n" + line;
    }
  }
  if (currentIndex >= 0) translations.set(currentIndex, currentText.trim());

  return flat.map((block, i) => ({
    blockId: block.blockId,
    type: block.type,
    original: block.text,
    translated: translations.get(i) || block.text,
  }));
}

async function handleChat(text: string, articleContext: string): Promise<void> {
  let client: CodexClient;
  try {
    client = await ensureConnected();
  } catch {
    broadcast({ type: "CHAT_ERROR", error: "Codex app-serverに接続できません。" });
    return;
  }

  const prompt = articleContext
    ? `以下の記事の内容を踏まえて質問に答えてください。必要に応じてWeb検索も行ってください。

記事の内容:
${articleContext}

ユーザーの質問: ${text}`
    : text;

  try {
    const response = await client.sendMessage(
      prompt,
      (delta) => broadcast({ type: "CHAT_DELTA", delta }),
      () => broadcast({ type: "IMAGE_GENERATING" }),
      (base64, revisedPrompt) => broadcast({ type: "IMAGE_COMPLETE", base64, revisedPrompt }),
    );
    broadcast({ type: "CHAT_COMPLETE", text: response });
  } catch (error) {
    broadcast({
      type: "CHAT_ERROR",
      error: error instanceof Error ? error.message : "エラーが発生しました",
    });
  }
}

chrome.runtime.onMessage.addListener((message: MessageType) => {
  if (message.type === "SCROLL_SYNC") broadcast(message);
  if (message.type === "HOVER_BLOCK") broadcast(message);
  if (message.type === "TRANSLATE_REQUEST") translateArticle(message.data);
  if (message.type === "CHAT_SEND") handleChat(message.text, message.articleContext || currentArticleText);

  if (message.type === "SIDEPANEL_SCROLL") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: "SCROLL_TO_BLOCK",
          blockId: (message as any).blockId,
        }).catch(() => {});
      }
    });
  }
});
