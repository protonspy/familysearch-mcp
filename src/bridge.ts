import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

export const DEFAULT_BRIDGE_PORT = 17345;

/** Pasta da extensão do Chrome distribuída junto com o pacote (carregada sem compactação). */
export const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");

export interface BridgeResponse {
  status: number;
  contentType: string;
  retryAfter?: string;
  body: Buffer;
}

interface Pending {
  resolve: (res: BridgeResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Lê a configuração compartilhada com a extensão (`config.json` na pasta dela) ou cria uma nova chave secreta.
 * A extensão lê esse arquivo para saber a porta e se autenticar; a chave só muda se a porta mudar.
 */
export function ensureBridgeConfig(dir: string, port: number) {
  const file = path.join(dir, "config.json");
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    if (cfg.port === port && typeof cfg.key === "string" && cfg.key.length >= 32) return cfg.key as string;
  } catch {
    // Sem configuração válida: gera uma nova abaixo.
  }
  const key = randomBytes(24).toString("hex");
  writeFileSync(file, `${JSON.stringify({ port, key }, null, 2)}\n`);
  return key;
}

/**
 * Ponte local (WebSocket em 127.0.0.1) com a extensão do Chrome: a extensão envia o token da sessão logada
 * e executa as requisições ao FamilySearch de dentro de uma aba do site, com a sessão do usuário.
 * Só aceita conexões de extensões (`Origin: chrome-extension://`) que apresentem a chave secreta.
 */
export class BrowserBridge {
  private socket?: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private readonly tokenListeners: ((token: string | null) => void)[] = [];
  private pingTimer?: NodeJS.Timeout;
  /** Último token informado pela extensão (null = navegador sem login no FamilySearch). */
  token: string | null = null;
  extensionVersion?: string;

  constructor(
    readonly port: number,
    private readonly key: string,
    private readonly timeoutMs = 60_000,
  ) {}

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  onToken(listener: (token: string | null) => void) {
    this.tokenListeners.push(listener);
  }

  /** Começa a escutar; resolve com a porta efetiva (útil com porta 0 nos testes). */
  start(): Promise<number> {
    const http = createServer((_req, res) => res.writeHead(426).end());
    const wss = new WebSocketServer({
      server: http,
      maxPayload: 64 * 1024 * 1024,
      verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) =>
        Boolean(origin?.startsWith("chrome-extension://")) && this.isValidKey(new URL(req.url ?? "/", "http://localhost").searchParams.get("key")),
    });
    wss.on("connection", (ws, req) => {
      // A ponte não deve impedir o processo do MCP de encerrar quando o cliente desconectar.
      req.socket.unref();
      this.attach(ws);
    });
    return new Promise((resolve, reject) => {
      // O WebSocketServer repete os erros do servidor HTTP; sem ouvinte, a porta ocupada derrubaria o processo.
      wss.on("error", reject);
      http.listen(this.port, "127.0.0.1", () => {
        http.unref();
        resolve((http.address() as AddressInfo).port);
      });
    });
  }

  /**
   * Executa uma requisição no FamilySearch pela extensão. `path` inclui a query string.
   * Sem `init` é um GET; a extensão só aceita POST em rotas de consulta específicas (ver background.js).
   */
  request(path: string, headers: Record<string, string>, init?: { method: string; body: string }): Promise<BridgeResponse> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Extensão do navegador não conectada."));
    const id = randomBytes(8).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("A extensão do navegador não respondeu a tempo."));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "request", id, path, headers, ...init }));
    });
  }

  private attach(ws: WebSocket) {
    // Uma extensão por vez: a conexão mais recente substitui a anterior (ex.: navegador reiniciado).
    this.socket?.close();
    this.socket = ws;
    clearInterval(this.pingTimer);
    // Tráfego periódico mantém vivo o service worker da extensão (Manifest V3).
    this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping" })), 20_000);
    this.pingTimer.unref();

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "hello") this.extensionVersion = msg.version;
      else if (msg.type === "token") this.setToken(typeof msg.token === "string" && msg.token ? msg.token : null);
      else if (msg.type === "response" || msg.type === "error") this.settle(msg);
    });
    ws.on("close", () => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      clearInterval(this.pingTimer);
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("A extensão do navegador desconectou."));
        this.pending.delete(id);
      }
    });
  }

  private settle(msg: any) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.type === "error") return p.reject(new Error(`Extensão do navegador: ${msg.message}`));
    p.resolve({
      status: Number(msg.status),
      contentType: msg.contentType ?? "",
      retryAfter: msg.retryAfter ?? undefined,
      body: Buffer.from(msg.base64 ?? "", "base64"),
    });
  }

  private setToken(token: string | null) {
    if (token === this.token) return;
    this.token = token;
    for (const listener of this.tokenListeners) listener(token);
  }

  private isValidKey(candidate: string | null) {
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.key);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
