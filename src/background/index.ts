import { CodexClient } from "../lib/codex-client";
import type { ArticleData, MessageType, TranslatedBlock, TranslationResult } from "../lib/types";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const DEFAULT_PROXY_TOKEN = "5f81c308b8f816ca72e3990e2cf77543";
const CHUNK_SIZE = 15;

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
      const token = settings.codexToken || DEFAULT_PROXY_TOKEN;
      codex = new CodexClient({ host, port, token });
      await codex.connect();
      await codex.ensureThread();
      console.log("[Xilot] Pre-warm: connected + thread ready");
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

setInterval(() => {
  if (codex?.isConnected()) return;
  warmupPromise = null;
  warmup().catch(() => {});
}, 20000);

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

  try {
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx];
      const globalOffset = idx * CHUNK_SIZE;
      const prompt = `あなたはプロの英日翻訳者です。以下の英語テキストを自然な日本語に翻訳してください。コマンド名・技術用語・固有名詞・コード等はそのまま英語で残し、文章部分だけを日本語にしてください。番号を維持して出力してください。

${chunk.map((b, i) => `[${i}] ${b.text}`).join("\n\n")}

[0] から順に翻訳を出力:
`;

      let parsed: TranslatedBlock[];
      try {
        const response = await client.sendMessage(prompt);
        parsed = parseChunkResponse(response, chunk);
      } catch {
        parsed = chunk.map((b) => ({
          blockId: b.blockId, type: b.type, original: b.text, translated: b.text,
        }));
      }

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

function parseChunkResponse(response: string, flat: ArticleData["blocks"][number][]): TranslatedBlock[] {
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

  console.log("[Xilot] handleChat:", text.slice(0, 100));

  const prompt = articleContext
    ? `あなたはユーザーのリサーチアシスタントです。以下の記事の内容を踏まえて質問に答えてください。

ルール:
- 記事に書かれていることはそのまま回答
- 記事に書かれていないこと、最新の情報、ユーザーが知らないことについて聞かれた場合はWeb検索を行って回答
- 画像の生成を依頼された場合はimage_genツールを使って生成すること
- 回答は日本語で

記事の内容:
${articleContext}

ユーザーの質問: ${text}`
    : `以下の質問に日本語で答えてください。必要に応じてWeb検索を行ってください。画像生成を依頼された場合はimage_genツールを使ってください。\n\n${text}`;

  try {
    const response = await client.sendMessage(
      prompt,
      (delta) => broadcast({ type: "CHAT_DELTA", delta }),
      () => broadcast({ type: "IMAGE_GENERATING" }),
      (base64, revisedPrompt) => broadcast({ type: "IMAGE_COMPLETE", base64, revisedPrompt }),
      (status) => broadcast({ type: "CHAT_PROCESSING", status } as any),
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
  if ((message as any).type === "SCROLL_RATIO") broadcast(message);
  if (message.type === "HOVER_BLOCK") broadcast(message);
  if (message.type === "TRANSLATE_REQUEST") translateArticle(message.data);
  if (message.type === "CHAT_SEND") handleChat(message.text, message.articleContext || currentArticleText);

  if ((message as any).type === "SIDEPANEL_SCROLL_RATIO") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: "SCROLL_TO_RATIO",
          ratio: (message as any).ratio,
        }).catch(() => {});
      }
    });
  }
});
