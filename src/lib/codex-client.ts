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

  constructor(config?: Partial<CodexConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async connect(): Promise<void> {
    const url = `ws://${this.config.host}:${this.config.port}`;
    const protocols = this.config.token
      ? [`bearer.${this.config.token}`]
      : undefined;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, protocols);

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
    switch (notif.method) {
      case "item/agentMessage/delta":
        if (this.onDelta && notif.params) {
          this.onDelta(notif.params.delta as string);
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

  async sendMessage(
    text: string,
    onDelta?: (text: string) => void,
  ): Promise<string> {
    if (!this.threadId) {
      await this.startThread();
    }

    this.onDelta = onDelta ?? null;

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

    return fullResponse;
  }
}
