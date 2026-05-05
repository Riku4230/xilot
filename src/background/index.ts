import { CodexClient } from "../lib/codex-client";
import type { ArticleData, MessageType, TranslatedBlock, TranslationResult } from "../lib/types";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const DEFAULT_PROXY_TOKEN = "5f81c308b8f816ca72e3990e2cf77543";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["codexToken"], (result) => {
    if (!result.codexToken) {
      chrome.storage.local.set({ codexToken: DEFAULT_PROXY_TOKEN });
    }
  });
});

let codex: CodexClient | null = null;
let currentArticleText = "";

async function ensureConnected(): Promise<CodexClient> {
  if (codex?.isConnected()) return codex;

  const settings = await chrome.storage.local.get(["codexHost", "codexPort", "codexToken"]);
  const host = settings.codexHost || "127.0.0.1";
  const port = settings.codexPort || 4501;
  const token = settings.codexToken || "";

  codex?.disconnect();
  codex = new CodexClient({ host, port, token });
  await codex.connect();
  broadcast({ type: "CODEX_STATUS", connected: true });
  return codex;
}

function broadcast(msg: MessageType): void {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

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

  const prompt = `以下の英語の記事を日本語に翻訳してください。各段落を番号付きで翻訳してください。原文の段落構造を保持してください。見出しは見出しとして、引用は引用として翻訳してください。

記事タイトル: ${data.title}

${data.blocks.map((b, i) => `[${i}] ${b.text}`).join("\n\n")}

各段落を [番号] に対応させて翻訳し、以下の形式で出力してください:
[0] 翻訳文
[1] 翻訳文
...`;

  try {
    const response = await client.sendMessage(prompt, (delta) => {
      broadcast({ type: "TRANSLATION_DELTA", blockId: "", delta });
    });

    const translatedBlocks = parseTranslationResponse(response, data);
    broadcast({
      type: "TRANSLATION_RESULT",
      data: { url: data.url, title: data.title, author: data.author, blocks: translatedBlocks },
    });
  } catch (error) {
    broadcast({
      type: "TRANSLATION_ERROR",
      error: error instanceof Error ? error.message : "翻訳中にエラーが発生しました",
    });
  }
}

function parseTranslationResponse(response: string, data: ArticleData): TranslatedBlock[] {
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

  return data.blocks.map((block, i) => ({
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
