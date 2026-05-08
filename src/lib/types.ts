export interface ArticleBlock {
  blockId: string;
  type: "title" | "heading" | "paragraph" | "blockquote" | "list-item" | "code" | "image";
  text: string;
  offsetKey?: string;
}

export interface ArticleLink {
  url: string;
  text: string;
}

export interface ArticleMedia {
  type: "image";
  url: string;
  alt: string;
}

export interface ArticleData {
  kind?: "article" | "post";
  url: string;
  canonicalUrl?: string;
  title: string;
  author: string;
  timestamp: string;
  blocks: ArticleBlock[];
  links?: ArticleLink[];
  media?: ArticleMedia[];
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

export interface SessionImage {
  id: string;
  base64: string;
  revisedPrompt: string;
  mimeType: string;
  createdAt: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  images?: SessionImage[];
}

export interface ChatSession {
  sessionId: string;
  articleUrl: string;
  articleTitle: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface LocalSavePayload {
  baseDir: string;
  article: ArticleData;
  translation: TranslationResult;
  session?: ChatSession;
}

export type MessageType =
  | { type: "EXTRACT_ARTICLE" }
  | { type: "ARTICLE_DATA"; data: ArticleData }
  | { type: "ARTICLE_NOT_FOUND" }
  | { type: "TRANSLATE_REQUEST"; data: ArticleData }
  | { type: "TRANSLATION_RESULT"; data: TranslationResult }
  | { type: "TRANSLATION_ERROR"; error: string }
  | { type: "TRANSLATION_DELTA"; blockId: string; delta: string }
  | { type: "TRANSLATION_CHUNK_DONE"; block: TranslatedBlock; progress: number; total: number }
  | { type: "SCROLL_SYNC"; blockId: string }
  | { type: "SCROLL_RATIO"; ratio: number; blockId: string }
  | { type: "SCROLL_TO_BLOCK"; blockId: string }
  | { type: "HOVER_BLOCK"; blockId: string }
  | { type: "SIDEPANEL_SCROLL"; blockId: string }
  | { type: "SIDEPANEL_SCROLL_RATIO"; ratio: number }
  | { type: "CHAT_SEND"; text: string; articleContext: string }
  | { type: "CHAT_DELTA"; delta: string }
  | { type: "CHAT_COMPLETE"; text: string }
  | { type: "CHAT_ERROR"; error: string }
  | { type: "CHAT_PROCESSING"; status: string }
  | { type: "IMAGE_GENERATING" }
  | { type: "IMAGE_COMPLETE"; base64: string; revisedPrompt: string }
  | { type: "CODEX_STATUS"; connected: boolean };
