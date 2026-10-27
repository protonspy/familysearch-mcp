import { readFileSync } from "node:fs";

export const FS_JSON = "application/x-fs-v1+json";
export const FS_ATOM = "application/x-gedcomx-atom+json";
/** Os serviços de busca do site (/service/search/...) só aceitam JSON genérico. */
export const JSON_TYPE = "application/json";
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

export interface RequestOptions {
  accept?: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** Rotas que podem responder 404 sem que isso seja um erro (retorna null). */
  allowNotFound?: boolean;
}

/**
 * Cliente HTTP mínimo da API do FamilySearch autenticado com o token da sessão
 * do navegador (cookie `fssessionid`), enviado como Bearer token.
 */
export class FamilySearchClient {
  private token: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(
    // O site serve tanto a API pública (/platform) quanto os serviços internos (/service) no mesmo host.
    readonly baseUrl = process.env.FAMILYSEARCH_BASE_URL ?? "https://www.familysearch.org",
    readonly lang = process.env.FAMILYSEARCH_LANG ?? "pt",
    private readonly minIntervalMs = Number(process.env.FAMILYSEARCH_MIN_INTERVAL_MS ?? 150),
  ) {
    this.token = loadTokenFromEnv();
  }

  setToken(token: string) {
    this.token = normalizeToken(token);
  }

  hasToken() {
    return Boolean(this.token);
  }

  /** GET em uma rota do FamilySearch (ex.: `/platform/tree/persons/KWQS-BBQ`). */
  async get<T = any>(path: string, opts: RequestOptions = {}): Promise<T | null> {
    return this.request<T>(this.resolve(path, opts.query), opts);
  }

  private resolve(path: string, query?: RequestOptions["query"]) {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.append(key, String(value));
    }
    return url.toString();
  }

  private request<T>(url: string, opts: RequestOptions): Promise<T | null> {
    // Serializa as chamadas e respeita um intervalo mínimo para não estourar o throttling do FamilySearch.
    const run = this.queue.then(() => this.doRequest<T>(url, opts));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doRequest<T>(url: string, opts: RequestOptions, attempt = 0): Promise<T | null> {
    if (!this.token) {
      throw new FamilySearchError(
        "Nenhum token de sessão configurado. Defina FAMILYSEARCH_TOKEN ou use a tool fs_set_session_token.",
        401,
        url,
      );
    }

    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();

    const res = await fetch(url, {
      headers: {
        Accept: opts.accept ?? FS_JSON,
        Authorization: `Bearer ${this.token}`,
        "Accept-Language": this.lang,
        // O firewall do FamilySearch bloqueia (403, errorCode 15) User-Agents que não parecem de navegador.
        "User-Agent": USER_AGENT,
      },
      redirect: "follow",
    });

    if (res.status === 429 || res.status === 503) {
      if (attempt >= 4) throw new FamilySearchError("FamilySearch limitou as requisições (throttling).", res.status, url);
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
      return this.doRequest<T>(url, opts, attempt + 1);
    }

    if (res.status === 204 || res.status === 304) return null;
    if (res.status === 404 && opts.allowNotFound) return null;

    const text = await res.text();
    if (!res.ok) {
      throw new FamilySearchError(describeStatus(res.status, text), res.status, url, text.slice(0, 2000));
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FamilySearchError("Resposta do FamilySearch não é JSON.", res.status, url, text.slice(0, 500));
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
