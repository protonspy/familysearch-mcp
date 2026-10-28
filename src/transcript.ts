import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { type FamilySearchClient, JSON_TYPE, TRANSCRIPT_ORIGIN } from "./client.js";
import type { Region } from "./imaging.js";

/**
 * Transcrições automáticas (IA) das páginas, as mesmas do painel "Transcrição" do visualizador do site.
 * Ficam num host separado da API e exigem o cabeçalho `FS-User-Agent-Chain` (identificação de quem chama).
 */
export const TRANSCRIPT_CALLER = "familysearch-mcp";
export const transcriptUrl = (imageId: string) => `${TRANSCRIPT_ORIGIN}/service/records/volunteer/orchestration/sls/image/records/3:1:${imageId}`;

export interface TranscriptLine {
  text: string;
  /** Posição na imagem inteira, em coordenadas normalizadas (0–1), como em fs_view_document. */
  region: Region;
}

export interface PageText {
  imageId: string;
  width: number;
  height: number;
  /** Linhas por bloco da página, de cima para baixo dentro de cada bloco. */
  blocks: TranscriptLine[][];
}

/** Lê a resposta do serviço de transcrição; null quando a página não tem texto reconhecido. */
export function parseTranscript(imageId: string, data: any): PageText | null {
  const stuff = data?.stuff;
  const page = stuff?.pages?.[0];
  const width = Number(page?.pageWidth);
  const height = Number(page?.pageHeight);
  if (!width || !height || !Array.isArray(stuff?.regions)) return null;
  const toRegion = (rect: unknown): Region | undefined => {
    const [x, y, w, h] = String(rect ?? "").split(",").map(Number);
    if (![x, y, w, h].every(Number.isFinite)) return undefined;
    return { x: round(x / width), y: round(y / height), width: round(w / width), height: round(h / height) };
  };
  const blocks = stuff.regions
    .map((r: any) =>
      (r.lines ?? [])
        .map((l: any) => ({ text: (l.tokens ?? []).map((t: any) => t.text ?? "").join(" ").replace(/\s+/g, " ").trim(), region: toRegion(l.rect) }))
        .filter((l: { text: string; region?: Region }): l is TranscriptLine => Boolean(l.text && l.region))
        .sort((a: TranscriptLine, b: TranscriptLine) => a.region.y - b.region.y || a.region.x - b.region.x),
    )
    .filter((b: TranscriptLine[]) => b.length);
  return blocks.length ? { imageId, width, height, blocks } : null;
}

export const pageText = (page: PageText) => page.blocks.map((b) => b.map((l) => l.text).join("\n")).join("\n\n");

export interface LineMark extends TranscriptLine {
  /** "1", "2"… no corpo do texto; "A", "B"… na coluna da margem (nº do assento e nomes). */
  label: string;
  kind: "body" | "margin";
}

/**
 * Linhas da transcrição dentro de uma região, rotuladas para conferir a leitura sobre a imagem. Descarta o ruído
 * do reconhecimento (setas, tiques, fragmentos) e separa a coluna da margem: linhas estreitas que terminam antes
 * de onde começam as linhas largas do corpo.
 */
export function marksInRegion(page: PageText, region: Region): LineMark[] {
  const inside = page.blocks
    .flat()
    .filter((l) => {
      const cx = l.region.x + l.region.width / 2;
      const cy = l.region.y + l.region.height / 2;
      const within = cx >= region.x && cx <= region.x + region.width && cy >= region.y && cy <= region.y + region.height;
      const meaningful = /\d\d/.test(l.text) || (l.text.replace(/[^\p{L}]/gu, "").length >= 3 && l.region.width > 0.02);
      return within && meaningful;
    })
    .sort((a, b) => a.region.y + a.region.height / 2 - (b.region.y + b.region.height / 2) || a.region.x - b.region.x);
  const widest = Math.max(0, ...inside.map((l) => l.region.width));
  // Mediana (não o mínimo) do início das linhas largas: uma linha torta ou um cabeçalho não desloca a coluna.
  const starts = inside
    .filter((l) => l.region.width >= widest / 2)
    .map((l) => l.region.x)
    .sort((a, b) => a - b);
  const bodyLeft = starts[Math.floor(starts.length / 2)] ?? 0;
  let body = 0;
  let margin = 0;
  return inside.map((l) => {
    const isMargin = l.region.width < widest / 2 && l.region.x + l.region.width <= bodyLeft + 0.01;
    return isMargin
      ? { ...l, kind: "margin" as const, label: String.fromCharCode(65 + (margin++ % 26)) }
      : { ...l, kind: "body" as const, label: String(++body) };
  });
}

/**
 * Transcrições já baixadas ficam em disco (a transcrição de uma página não muda), então buscar de novo
 * no mesmo livro, com outros nomes, não refaz as requisições.
 */
export class TranscriptStore {
  private memory = new Map<string, PageText | null>();

  constructor(
    private readonly client: FamilySearchClient,
    readonly cacheDir = process.env.FAMILYSEARCH_TEXT_CACHE_DIR ?? path.join(homedir(), ".familysearch-mcp", "text"),
  ) {}

  /** Transcrição da página, ou null se o FamilySearch não tem texto reconhecido para ela. */
  async get(imageId: string): Promise<{ page: PageText | null; source: "memória" | "cache" | "rede" }> {
    if (this.memory.has(imageId)) return { page: this.memory.get(imageId)!, source: "memória" };
    const file = path.join(this.cacheDir, `${imageId}.json`);
    const cached = await readFile(file, "utf8").then(JSON.parse, () => undefined);
    if (cached !== undefined) {
      const page = cached.blocks ? (cached as PageText) : null;
      this.memory.set(imageId, page);
      return { page, source: "cache" };
    }
    const data = await this.client.get(transcriptUrl(imageId), {
      accept: JSON_TYPE,
      headers: { "FS-User-Agent-Chain": TRANSCRIPT_CALLER },
      allowNotFound: true,
    });
    const page = parseTranscript(imageId, data);
    this.memory.set(imageId, page);
    await mkdir(this.cacheDir, { recursive: true })
      .then(() => writeFile(file, JSON.stringify(page ?? { imageId, empty: true })))
      .catch(() => undefined);
    return { page, source: "rede" };
  }
}

/**
 * Forma comparável de uma palavra: sem acento, minúscula e com as variações de grafia antigas unificadas
 * (z/s, y/i, ph/f, th/t, letras dobradas), para que "Sinezia" e "Synesia" encontrem "Sinesia".
 */
export function foldWord(word: string) {
  return word
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/ph/g, "f")
    .replace(/th/g, "t")
    .replace(/y/g, "i")
    .replace(/z/g, "s")
    .replace(/(.)\1+/g, "$1");
}

/** Distância de edição limitada: devolve `max + 1` assim que passar do limite. */
export function editDistance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Erros tolerados por palavra: a transcrição troca letras de nomes manuscritos com frequência. */
const tolerance = (word: string) => (word.length >= 8 ? 2 : word.length >= 5 ? 1 : 0);

interface Token {
  raw: string;
  folded: string;
  line: number;
}

/** Palavras das linhas, juntando as partidas na translineação ("Fran -" / "cisco", "Con=" / "ceição"). */
function tokenize(lines: TranscriptLine[]) {
  const tokens: Token[] = [];
  let glue = false;
  lines.forEach((l, line) => {
    for (const piece of l.text.split(/\s+/)) {
      const hyphen = /^[-=–]+$/.test(piece);
      const word = piece.replace(/[-=–]+$/, "");
      if (word && !hyphen) {
        const prev = tokens.at(-1);
        if (glue && prev) {
          prev.raw += word;
          prev.folded = foldWord(prev.raw);
        } else tokens.push({ raw: word.replace(/[.,;:()]+$/g, ""), folded: foldWord(word), line });
      }
      glue = hyphen || (word !== piece && Boolean(word));
    }
  });
  return tokens.filter((t) => t.folded);
}

export interface TermMatch {
  term: string;
  found: string;
  distance: number;
}

/** Procura cada termo (palavra ou expressão de várias palavras seguidas) nos tokens. */
function matchTerms(tokens: Token[], terms: string[][], fuzzy: boolean) {
  const matches: (TermMatch & { line: number })[] = [];
  terms.forEach((words) => {
    const folded = words.map(foldWord);
    for (let i = 0; i + folded.length <= tokens.length; i++) {
      let distance = 0;
      for (let k = 0; k < folded.length && distance >= 0; k++) {
        const d = fuzzy ? editDistance(tokens[i + k].folded, folded[k], tolerance(folded[k])) : tokens[i + k].folded === folded[k] ? 0 : 1;
        distance = d > (fuzzy ? tolerance(folded[k]) : 0) ? -1 : distance + d;
      }
      if (distance >= 0) {
        const span = tokens.slice(i, i + folded.length);
        matches.push({ term: words.join(" "), found: span.map((t) => t.raw).join(" "), distance, line: span[0].line });
      }
    }
  });
  return matches;
}

export interface TextHit {
  imageNumber?: number;
  imageId: string;
  terms: string[];
  matches: TermMatch[];
  snippet: string;
  region: Region;
}

export interface TextSearchOptions {
  fuzzy?: boolean;
  /** Mínimo de termos diferentes no mesmo trecho (padrão: todos, até 2). */
  minTerms?: number;
  /** Linhas por trecho: um assento costuma ocupar de 5 a 10 linhas. */
  windowLines?: number;
}

/**
 * Trechos de uma página que reúnem os termos procurados. Cada trecho vem com o texto transcrito e a região
 * na imagem (para recortar com fs_view_document); trechos sobrepostos são unidos.
 */
export function searchPage(page: PageText, rawTerms: string[], opts: TextSearchOptions = {}, imageNumber?: number): TextHit[] {
  const terms = rawTerms.map((t) => t.trim().split(/\s+/).filter(Boolean)).filter((t) => t.length);
  if (!terms.length) return [];
  const fuzzy = opts.fuzzy ?? true;
  const minTerms = Math.min(opts.minTerms ?? Math.min(terms.length, 2), terms.length);
  const windowLines = opts.windowLines ?? 6;
  const hits: TextHit[] = [];
  for (const lines of page.blocks) {
    const matches = matchTerms(tokenize(lines), terms, fuzzy);
    if (!matches.length) continue;
    // Janela que começa em cada linha com acerto; fica a que reúne mais termos, sem repetir linhas.
    const windows = [...new Set(matches.map((m) => m.line))]
      .map((start) => {
        const inside = matches.filter((m) => m.line >= start && m.line < start + windowLines);
        const best = new Map<string, (typeof inside)[number]>();
        for (const m of inside) if (!best.has(m.term) || best.get(m.term)!.distance > m.distance) best.set(m.term, m);
        const chosen = [...best.values()];
        const last = Math.max(...chosen.map((m) => m.line));
        return { start: Math.min(...chosen.map((m) => m.line)), end: last, chosen, score: chosen.length * 10 - chosen.reduce((s, m) => s + m.distance, 0) };
      })
      .filter((w) => w.chosen.length >= minTerms)
      .sort((a, b) => b.score - a.score || a.start - b.start);
    const used = new Set<number>();
    for (const w of windows) {
      if ([...Array(w.end - w.start + 1).keys()].some((i) => used.has(w.start + i))) continue;
      const from = Math.max(0, w.start - 1);
      const to = Math.min(lines.length - 1, w.end + 1);
      for (let i = w.start; i <= w.end; i++) used.add(i);
      const context = lines.slice(from, to + 1);
      hits.push({
        imageNumber,
        imageId: page.imageId,
        terms: w.chosen.map((m) => m.term),
        matches: w.chosen.map(({ term, found, distance }) => ({ term, found, distance })),
        snippet: context.map((l) => l.text).join(" ").slice(0, 700),
        region: padded(unionRegion(context.map((l) => l.region))),
      });
    }
  }
  return hits;
}

function unionRegion(regions: Region[]): Region {
  const x = Math.min(...regions.map((r) => r.x));
  const y = Math.min(...regions.map((r) => r.y));
  const right = Math.max(...regions.map((r) => r.x + r.width));
  const bottom = Math.max(...regions.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Folga em volta do trecho, incluindo a margem à esquerda onde ficam os nomes dos noivos e o número do assento. */
function padded(r: Region): Region {
  const x = Math.max(0, r.x - 0.12);
  const y = Math.max(0, r.y - 0.03);
  const right = Math.min(1, r.x + r.width + 0.02);
  const bottom = Math.min(1, r.y + r.height + 0.04);
  return { x: round(x), y: round(y), width: round(right - x), height: round(bottom - y) };
}

const round = (n: number) => Math.round(n * 10000) / 10000;
