import { readFileSync } from "node:fs";
import type { BrowserBridge } from "./bridge.js";

export const FS_JSON = "application/x-fs-v1+json";
export const FS_ATOM = "application/x-gedcomx-atom+json";
/** Os serviços de busca do site (/service/search/...) só aceitam JSON genérico. */
export const JSON_TYPE = "application/json";
/** Host das transcrições automáticas das páginas; o único fora de www que também passa pela extensão. */
export const TRANSCRIPT_ORIGIN = "https://sg30p0.familysearch.org";
const USER_AGENT =
  process.env.FAMILYSEARCH_USER_AGENT ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export class FamilySearchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "FamilySearchError";
  }
}

/** A proteção anti-robô do site respondeu com a página "Pardon Our Interruption" no lugar do conteúdo. */
export class BotChallengeError extends FamilySearchError {
  constructor(
    url: string,
    readonly viaBrowser: boolean,
  ) {
    super(
      viaBrowser
        ? 'O FamilySearch pediu uma verificação anti-robô ("Pardon Our Interruption") no navegador. ' +
            "Abra o FamilySearch no Chrome, conclua a verificação se ela aparecer e tente de novo em alguns minutos."
        : 'O FamilySearch pausou as requisições com uma verificação anti-robô ("Pardon Our Interruption"). ' +
            "Aguarde alguns minutos ou conecte a extensão do navegador (fs_browser_status).",
      429,
      url,
    );
    this.name = "BotChallengeError";
  }
}

export type TokenSource = "extension" | "env" | "manual";

/** Depois de um bloqueio anti-robô no modo direto, não insiste em baixar imagens por este tempo. */
const DIRECT_IMAGE_COOLDOWN_MS = 30 * 60_000;

export interface RequestOptions {
  accept?: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** Rotas que podem responder 404 sem que isso seja um erro (retorna null). */
  allowNotFound?: boolean;
  /** Corpo JSON de um POST (só usado por `post`). */
  body?: unknown;
  /** Cabeçalhos extras (ex.: `FS-User-Agent-Chain`, exigido pelo serviço de transcrições). */
  headers?: Record<string, string>;
}

export interface BinaryResponse {
  data: Buffer;
  contentType: string;
}

/**
 * Cliente HTTP mínimo da API do FamilySearch autenticado com o token da sessão
 * do navegador (cookie `fssessionid`), enviado como Bearer token.
 *
 * Com a extensão do Chrome conectada, as requisições saem do navegador do usuário e o token
 * é atualizado automaticamente; sem ela, o cliente faz as requisições diretamente.
 */
export class FamilySearchClient {
  private token: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private bridge?: BrowserBridge;
  private directImagesBlockedUntil = 0;
  tokenSource?: TokenSource;

  constructor(
    // O site serve tanto a API pública (/platform) quanto os serviços internos (/service) no mesmo host.
    readonly baseUrl = process.env.FAMILYSEARCH_BASE_URL ?? "https://www.familysearch.org",
    readonly lang = process.env.FAMILYSEARCH_LANG ?? "pt",
    private readonly minIntervalMs = Number(process.env.FAMILYSEARCH_MIN_INTERVAL_MS ?? 150),
    // Downloads de imagem (~1 MB cada) são espaçados mais, para não disparar a proteção anti-robô.
    private readonly minImageIntervalMs = Number(process.env.FAMILYSEARCH_MIN_IMAGE_INTERVAL_MS ?? 1500),
  ) {
    this.token = loadTokenFromEnv();
    if (this.token) this.tokenSource = "env";
  }

  setToken(token: string, source: TokenSource = "manual") {
    this.token = normalizeToken(token);
    this.tokenSource = source;
  }

  hasToken() {
    return Boolean(this.token);
  }

  /** Passa a usar a extensão do navegador: requisições pelo Chrome e token da sessão logada. */
  attachBridge(bridge: BrowserBridge) {
    this.bridge = bridge;
    if (bridge.token) this.setToken(bridge.token, "extension");
    // Logout no navegador não apaga o token atual: o modo direto continua com ele até expirar.
    bridge.onToken((token) => token && this.setToken(token, "extension"));
  }

  status() {
    return {
      extension: this.bridge
        ? { port: this.bridge.port, connected: this.bridge.connected, version: this.bridge.extensionVersion, loggedIn: Boolean(this.bridge.token) }
        : undefined,
      tokenSource: this.token ? this.tokenSource : undefined,
      directImagesBlockedUntil:
        this.directImagesBlockedUntil > Date.now() ? new Date(this.directImagesBlockedUntil).toISOString() : undefined,
    };
  }

  /** GET em uma rota do FamilySearch (ex.: `/platform/tree/persons/KWQS-BBQ`). */
  async get<T = any>(path: string, opts: RequestOptions = {}): Promise<T | null> {
    return this.request<T>(this.resolve(path, opts.query), opts);
  }

  /**
   * POST de leitura com corpo JSON. Usado só por serviços do site que consultam via POST
   * (ex.: `/search/filmdatainfo/film-data`, a lista de imagens de um filme digital).
   */
  async post<T = any>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T | null> {
    return this.request<T>(this.resolve(path, opts.query), { ...opts, body });
  }

  /** GET de conteúdo binário (ex.: imagens de documentos), pela mesma fila e política de retentativa. */
  async getBinary(path: string, opts: RequestOptions = {}): Promise<BinaryResponse | null> {
    // Só `image/*` faz o servidor de imagens responder 406 em vez do 403 de imagem restrita.
    return this.request<BinaryResponse>(this.resolve(path, opts.query), { accept: "image/*, */*;q=0.8", ...opts }, true);
  }

  private resolve(path: string, query?: RequestOptions["query"]) {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.append(key, String(value));
    }
    return url.toString();
  }

  private request<T>(url: string, opts: RequestOptions, binary = false): Promise<T | null> {
    // Serializa as chamadas e respeita um intervalo mínimo para não estourar o throttling do FamilySearch.
    const run = this.queue.then(() => this.doRequest<T>(url, opts, binary));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doRequest<T>(url: string, opts: RequestOptions, binary: boolean, attempt = 0): Promise<T | null> {
    if (!this.token) {
      throw new FamilySearchError(
        "Nenhum token de sessão. Conecte a extensão do Chrome logada no FamilySearch (fs_browser_status), " +
          "defina FAMILYSEARCH_TOKEN ou use a tool fs_set_session_token.",
        401,
        url,
      );
    }
    const origin = new URL(url).origin;
    const viaBrowser = Boolean(this.bridge?.connected) && (origin === new URL(this.baseUrl).origin || origin === TRANSCRIPT_ORIGIN);
    if (binary && !viaBrowser && Date.now() < this.directImagesBlockedUntil) throw new BotChallengeError(url, false);

    const wait = this.lastRequestAt + (binary ? Math.max(this.minIntervalMs, this.minImageIntervalMs) : this.minIntervalMs) - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();

    const headers: Record<string, string> = {
      Accept: opts.accept ?? FS_JSON,
      Authorization: `Bearer ${this.token}`,
      "Accept-Language": this.lang,
      ...opts.headers,
    };
    const init = opts.body === undefined ? undefined : { method: "POST", body: JSON.stringify(opts.body) };
    if (init) headers["Content-Type"] = JSON_TYPE;
    let res: Response;
    try {
      res = viaBrowser ? await this.fetchViaBrowser(url, headers, init) : await this.fetchDirect(url, headers, init);
    } catch (err) {
      // Queda de conexão (ECONNRESET, "fetch failed") no meio de uma varredura longa: tenta de novo algumas vezes.
      if (!(err instanceof TypeError) || attempt >= 2) throw err;
      await sleep(1000 * 2 ** attempt);
      return this.doRequest<T>(url, opts, binary, attempt + 1);
    }

    if (res.status === 429 || res.status === 503) {
      if (attempt >= 4) throw new FamilySearchError("FamilySearch limitou as requisições (throttling).", res.status, url);
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
      return this.doRequest<T>(url, opts, binary, attempt + 1);
    }

    if (res.status === 204 || res.status === 304) return null;
    if (res.status === 404 && opts.allowNotFound) return null;

    const contentType = res.headers.get("content-type") ?? "";
    if (res.ok && binary && !contentType.startsWith("text/html")) {
      return { data: Buffer.from(await res.arrayBuffer()), contentType } as T;
    }
    const text = await res.text();
    // A proteção anti-robô do site responde 200 com uma página HTML de desafio no lugar do conteúdo.
    if (contentType.startsWith("text/html") && text.includes("Pardon Our Interruption")) {
      if (binary && !viaBrowser) this.directImagesBlockedUntil = Date.now() + DIRECT_IMAGE_COOLDOWN_MS;
      throw new BotChallengeError(url, viaBrowser);
    }
    if (!res.ok) {
      throw new FamilySearchError(describeStatus(res.status, text), res.status, url, text.slice(0, 2000));
    }
    if (binary) throw new FamilySearchError(`Esperava uma imagem e o FamilySearch respondeu ${contentType || "sem tipo"}.`, res.status, url);
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FamilySearchError("Resposta do FamilySearch não é JSON.", res.status, url, text.slice(0, 500));
    }
  }

  private fetchDirect(url: string, headers: Record<string, string>, init?: RequestInit) {
    // Os serviços em /search/ do site autenticam pelo cookie da sessão, não pelo Bearer token.
    const cookie: Record<string, string> = new URL(url).pathname.startsWith("/search/") ? { Cookie: `fssessionid=${this.token}` } : {};
    return fetch(url, {
      ...init,
      // O firewall do FamilySearch bloqueia (403, errorCode 15) User-Agents que não parecem de navegador.
      headers: { ...headers, ...cookie, "User-Agent": USER_AGENT },
      redirect: "follow",
    });
  }

  /** Executa a requisição pela extensão; se ela cair no meio do caminho, faz a requisição diretamente. */
  private async fetchViaBrowser(url: string, headers: Record<string, string>, init?: { method: string; body: string }) {
    const { origin, pathname, search } = new URL(url);
    try {
      // Fora do host principal (transcrições), a extensão precisa saber o host de destino.
      const r = await this.bridge!.request(pathname + search, headers, init, origin === new URL(this.baseUrl).origin ? undefined : origin);
      const nullBody = r.status === 204 || r.status === 304;
      return new Response(nullBody ? null : new Uint8Array(r.body), {
        status: r.status,
        headers: { "content-type": r.contentType, ...(r.retryAfter ? { "retry-after": r.retryAfter } : {}) },
      });
    } catch (err) {
      if (this.bridge?.connected) throw err;
      return this.fetchDirect(url, headers, init);
    }
  }
}

function describeStatus(status: number, body: string) {
  switch (status) {
    case 401:
      return "Token de sessão inválido ou expirado. Copie um novo `fssessionid` do navegador logado.";
    case 403:
      if (body.includes("blocked by our security service")) {
        return "Requisição bloqueada pelo firewall do FamilySearch. Ajuste FAMILYSEARCH_USER_AGENT para um User-Agent de navegador.";
      }
      return "Acesso negado pelo FamilySearch para esta rota (pode exigir permissão de app ou dados de pessoa viva).";
    case 404:
      return "Recurso não encontrado no FamilySearch.";
    case 410:
      return "Recurso removido ou mesclado no FamilySearch.";
    default:
      return `FamilySearch respondeu HTTP ${status}: ${body.slice(0, 300)}`;
  }
}

function loadTokenFromEnv() {
  if (process.env.FAMILYSEARCH_TOKEN) return normalizeToken(process.env.FAMILYSEARCH_TOKEN);
  const file = process.env.FAMILYSEARCH_TOKEN_FILE;
  if (file) {
    try {
      return normalizeToken(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Aceita o valor puro, "Bearer xxx" ou "fssessionid=xxx". */
export function normalizeToken(raw: string) {
  return raw
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^fssessionid=/i, "")
    .replace(/;.*$/, "")
    .trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
