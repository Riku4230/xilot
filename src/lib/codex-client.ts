export interface CodexConfig {
  host: string;
  port: number;
  token: string;
}

const DEFAULT_CONFIG: CodexConfig = {
  host: "127.0.0.1",
  port: 4501,
  token: "",
};

type JsonRpcRequest = {
  method: string;
  id: number;
  params?: Record<string, unknown>;
};

type JsonRpcNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

type ServerMessage = JsonRpcResponse | JsonRpcNotification;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class CodexClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private threadId: string | null = null;
  private config: CodexConfig;
  private initialized = false;
  private onDelta: ((text: string) => void) | null = null;
  private onTurnComplete: (() => void) | null = null;
  private onImageStart: (() => void) | null = null;
  private onImageComplete: ((base64: string, revisedPrompt: string) => void) | null = null;

  constructor(config?: Partial<CodexConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async connect(): Promise<void> {
    const tokenParam = this.config.token ? `?token=${this.config.token}` : "";
    const url = `ws://${this.config.host}:${this.config.port}/${tokenParam}`;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.onopen = async () => {
        try {
          await this.initialize();
          this.initialized = true;
          resolve();
        } catch (e) {
          reject(e);
        }
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data as string);
      };

      this.ws.onerror = () => {
        reject(new Error(`Codex app-serverに接続できません (${url})`));
      };

      this.ws.onclose = () => {
        this.initialized = false;
        this.threadId = null;
      };
    });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.initialized = false;
    this.threadId = null;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.initialized;
  }

  private send(msg: JsonRpcRequest | { method: string; params?: Record<string, unknown> }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this.ws.send(JSON.stringify(msg));
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ method, id, params });
    });
  }

  private handleMessage(raw: string): void {
    const msg: ServerMessage = JSON.parse(raw);

    if ("id" in msg && msg.id != null) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if ("error" in msg && msg.error) {
          p.reject(new Error(msg.error.message));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }

    const notif = msg as JsonRpcNotification;
    const params = notif.params as Record<string, unknown> | undefined;
    const item = params?.item as Record<string, unknown> | undefined;

    console.log("[Xilot]", notif.method, item?.type || "", item?.status || "");

    switch (notif.method) {
      case "item/agentMessage/delta":
        if (this.onDelta && params) {
          this.onDelta(params.delta as string);
        }
        break;
      case "item/started":
        if (item?.type === "imageGeneration") {
          this.onImageStart?.();
        }
        break;
      case "item/completed":
        if (item?.type === "imageGeneration" && item.result) {
          this.onImageComplete?.(
            item.result as string,
            (item.revisedPrompt as string) || "",
          );
        }
        break;
      case "turn/completed":
        this.onTurnComplete?.();
        break;
    }
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "xilot",
        title: "Xilot",
        version: "0.1.0",
      },
      capabilities: {},
    });
    this.send({ method: "initialized", params: {} });
  }

  async startThread(): Promise<string> {
    const result = (await this.request("thread/start", {
      reasoningEffort: "low",
    })) as { thread: { id: string } };
    this.threadId = result.thread.id;
    return this.threadId;
  }

  async ensureThread(): Promise<void> {
    if (!this.threadId) await this.startThread();
  }

  async sendMessageNewThread(text: string): Promise<string> {
    return this.sendMessage(text);
  }

  async sendMessage(
    text: string,
    onDelta?: (text: string) => void,
    onImageStart?: () => void,
    onImageComplete?: (base64: string, revisedPrompt: string) => void,
  ): Promise<string> {
    if (!this.threadId) {
      await this.startThread();
    }

    this.onDelta = onDelta ?? null;
    this.onImageStart = onImageStart ?? null;
    this.onImageComplete = onImageComplete ?? null;

    let fullResponse = "";
    const originalOnDelta = this.onDelta;
    this.onDelta = (delta) => {
      fullResponse += delta;
      originalOnDelta?.(delta);
    };

    const turnComplete = new Promise<void>((resolve) => {
      this.onTurnComplete = resolve;
    });

    await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text }],
    });

    await turnComplete;

    this.onDelta = null;
    this.onTurnComplete = null;
    this.onImageStart = null;
    this.onImageComplete = null;

    return fullResponse;
  }
}
