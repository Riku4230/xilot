export interface ArticleBlock {
  blockId: string;
  type: "title" | "heading" | "paragraph" | "blockquote" | "list-item" | "code" | "image";
  text: string;
  offsetKey?: string;
}

export interface ArticleData {
  url: string;
  title: string;
  author: string;
  timestamp: string;
  blocks: ArticleBlock[];
}

export interface TranslatedBlock {
  blockId: string;
  type: ArticleBlock["type"];
  original: string;
  translated: string;
}

export interface TranslationResult {
  url: string;
  title: string;
  author: string;
  blocks: TranslatedBlock[];
}

export type MessageType =
  | { type: "EXTRACT_ARTICLE" }
  | { type: "ARTICLE_DATA"; data: ArticleData }
  | { type: "ARTICLE_NOT_FOUND" }
  | { type: "TRANSLATE_REQUEST"; data: ArticleData }
  | { type: "TRANSLATION_RESULT"; data: TranslationResult }
  | { type: "TRANSLATION_ERROR"; error: string }
  | { type: "TRANSLATION_DELTA"; blockId: string; delta: string }
  | { type: "SCROLL_SYNC"; blockId: string }
  | { type: "SCROLL_TO_BLOCK"; blockId: string }
  | { type: "HOVER_BLOCK"; blockId: string }
  | { type: "SIDEPANEL_SCROLL"; blockId: string }
  | { type: "CHAT_SEND"; text: string; articleContext: string }
  | { type: "CHAT_DELTA"; delta: string }
  | { type: "CHAT_COMPLETE"; text: string }
  | { type: "CHAT_ERROR"; error: string }
  | { type: "IMAGE_GENERATING" }
  | { type: "IMAGE_COMPLETE"; base64: string; revisedPrompt: string }
  | { type: "CODEX_STATUS"; connected: boolean };
