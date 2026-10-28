// Pesquisa complementar: navegação de pastas de imagens (waypoints), busca de texto completo,
// catálogo e filmes digitais. Rotas mapeadas a partir do tráfego do site com uma sessão logada.
import { type Gedcomx, type GxSourceDescription, type SearchFacet, clean } from "./gedcomx.js";

const ORIGIN = "https://www.familysearch.org";

export const DISCOVERY_ROUTES = {
  /** Pastas de primeiro nível de uma coleção de imagens (estados, países...). */
  collectionWaypoints: (collectionId: string) => `/platform/records/collections/${collectionId}/waypoints`,
  /** Uma pasta: subpastas ou, no último nível, as imagens do livro. Exige `?cc=<coleção>`. */
  waypoint: (waypointId: string) => `/platform/records/waypoints/${waypointId}`,
  /** Busca nas transcrições automáticas (texto completo) das imagens. */
  fullTextSearch: "/service/search/fulltext/search",
  catalogSearch: "/service/search/catalog/v3/search",
  catalogItem: (id: string) => `/service/search/catalog/item/${id}`,
  /** Lista de imagens de um filme digital (DGS); o site só a oferece via POST. */
  filmData: "/search/filmdatainfo/film-data",
} as const;

/** Accept que as rotas de waypoint aceitam (o mesmo que o visualizador de imagens usa). */
export const GEDCOMX_JSON = "application/x-gedcomx-v1+json";

const arkImageId = (value?: string) => value?.match(/3:1:([A-Z0-9-]+)/i)?.[1]?.toUpperCase();

/** Extrai o id da pasta e a coleção de uma URL de waypoint, ou a coleção da URL da raiz de waypoints. */
export function parseWaypointUrl(url?: string): { waypointId?: string; collectionId?: string } {
  if (!url) return {};
  let parsed: URL;
  try {
    parsed = new URL(url, ORIGIN);
  } catch {
    return {};
  }
  const waypoint = parsed.pathname.match(/\/platform\/records\/waypoints\/([^/]+)/)?.[1];
  const root = parsed.pathname.match(/\/platform\/records\/collections\/(\d+)\/waypoints/)?.[1];
  return clean({ waypointId: waypoint ? decodeURIComponent(waypoint) : undefined, collectionId: parsed.searchParams.get("cc") ?? root });
}

const isFolder = (s: GxSourceDescription) => Boolean(s.resourceType?.endsWith("/Collection"));
const titleOf = (s?: GxSourceDescription) => s?.titles?.[0]?.value?.split("; http")[0]?.trim();

/** Cadeia de pastas de uma descrição até a coleção (da mais alta para a mais baixa), sem títulos repetidos. */
function folderChain(start: GxSourceDescription | undefined, byId: Map<string | undefined, GxSourceDescription>) {
  const chain: GxSourceDescription[] = [];
  for (let sd = start; sd && chain.length < 12; sd = byId.get(sd.componentOf?.description?.replace(/^#/, ""))) {
    if (chain.includes(sd)) break;
    chain.unshift(sd);
  }
  return chain;
}

function chainSummary(chain: GxSourceDescription[]) {
  const folders: { title?: string; waypointId?: string }[] = [];
  for (const sd of chain) {
    const title = titleOf(sd);
    const { waypointId } = parseWaypointUrl(sd.about);
    if (!title || folders.at(-1)?.title === title) continue;
    folders.push(clean({ title, waypointId }));
  }
  return folders;
}

/**
 * Pastas acima de uma imagem, a partir dos metadados dela (`/platform/records/images/3:1:…`).
 * Cada pasta traz o `waypointId`, que permite listar as pastas irmãs (ex.: os outros livros da paróquia).
 */
export function imageFolders(data: Gedcomx) {
  const sds = data.sourceDescriptions ?? [];
  const byId = new Map(sds.map((s) => [s.id, s]));
  const image = sds.find((s) => s.resourceType?.endsWith("/DigitalArtifact")) ?? sds[0];
  const parent = byId.get(image?.componentOf?.description?.replace(/^#/, ""));
  const chain = folderChain(parent, byId);
  const collectionId = chain.map((s) => parseWaypointUrl(s.about).collectionId).find(Boolean);
  return { collectionId, folders: chainSummary(chain) };
}

/** Conteúdo de uma pasta de imagens: onde ela fica, subpastas e, se for um livro, as imagens. */
export function summarizeWaypoint(data: Gedcomx, offset = 0, count = 50) {
  const sds = data.sourceDescriptions ?? [];
  const byId = new Map(sds.map((s) => [s.id, s]));
  const self = byId.get(data.description?.replace(/^#/, "")) ?? sds.find(isFolder);
  const chain = folderChain(self, byId);
  const inChain = new Set(chain);
  const subfolders = sds
    .filter((s) => isFolder(s) && !inChain.has(s) && parseWaypointUrl(s.about).waypointId)
    .map((s) => clean({ title: titleOf(s), waypointId: parseWaypointUrl(s.about).waypointId }));
  const images = sds.filter((s) => s.resourceType?.endsWith("/DigitalArtifact")).map((s) => arkImageId(s.about));
  const page = images.slice(offset, offset + count).map((imageId, i) => ({ number: offset + i + 1, imageId }));
  return clean({
    title: titleOf(self),
    path: chainSummary(chain),
    ...parseWaypointUrl(self?.about),
    folders: subfolders.length ? subfolders : undefined,
    totalImages: images.length || undefined,
    images: page.length ? page : undefined,
    nextOffset: offset + count < images.length ? offset + count : undefined,
  });
}

export interface FullTextQuery {
  text: string;
  place?: string;
  /** Ano ("1897") ou intervalo ("1890-1900"). */
  years?: string;
  collectionId?: string;
  filters?: string;
  count?: number;
  offset?: number;
}

/** Query string da busca de texto completo, no formato do site (`q.text`, `q.recordPlace`, `q.recordYear.from/.to`). */
export function fullTextQuery(q: FullTextQuery) {
  if (!q.text.trim()) throw new Error("Informe o texto a buscar.");
  const params = new URLSearchParams({
    count: String(q.count ?? 20),
    offset: String(q.offset ?? 0),
    "m.defaultFacets": "on",
    "m.queryRequireDefault": "on",
    "q.text": q.text.trim(),
  });
  if (q.place?.trim()) params.append("q.recordPlace", q.place.trim());
  const years = q.years?.match(/\d{3,4}/g);
  if (years?.length) {
    params.append("q.recordYear.from", years[0]);
    params.append("q.recordYear.to", years[1] ?? years[0]);
  }
  if (q.collectionId?.trim()) params.append("q.collectionId", q.collectionId.trim());
  for (const [k, v] of new URLSearchParams(q.filters ?? "")) params.append(k, v);
  return Object.fromEntries(params);
}

/**
 * Trechos do texto em volta dos termos destacados pela busca, sem sobreposição. Prefere os trechos que reúnem
 * mais termos diferentes (ex.: os nomes do casal no mesmo assento) e os devolve na ordem da página.
 */
export function snippetsAround(text: string, terms: string[], max = 3, radius = 160) {
  const hits: { at: number; term: string }[] = [];
  for (const term of terms) {
    if (!term.trim()) continue;
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    for (let m = re.exec(text); m; m = re.exec(text)) hits.push({ at: m.index, term: term.toLowerCase() });
  }
  hits.sort((a, b) => a.at - b.at);
  const windows: { start: number; end: number; terms: Set<string> }[] = [];
  for (const { at, term } of hits) {
    const start = Math.max(0, at - radius);
    const end = Math.min(text.length, at + radius);
    const last = windows.at(-1);
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      last.terms.add(term);
    } else windows.push({ start, end, terms: new Set([term]) });
  }
  return windows
    .map((w, i) => ({ ...w, i }))
    .sort((a, b) => b.terms.size - a.terms.size || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map(({ start, end }) => `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`);
}

function summarizeFacetGroups(facets?: SearchFacet[]) {
  if (!facets?.length) return undefined;
  return facets
    .map((g) => ({
      name: g.displayName,
      options: (g.facets ?? []).slice(0, 25).map((f) => clean({ name: f.displayName, count: f.count, params: f.params })),
    }))
    .filter((g) => g.options.length);
}

export function summarizeFullText(data: any, opts: { includeText?: boolean; maxTextChars?: number; snippets?: number; facets?: boolean } = {}) {
  return clean({
    total: data?.results as number | undefined,
    index: data?.index as number | undefined,
    hits: ((data?.entries ?? []) as any[]).map((e) => {
      const c = e.content ?? {};
      const text: string = c.textDocument ?? "";
      const terms = [...new Set<string>(c.highlightTexts ?? [])];
      return clean({
        imageId: arkImageId(e.id),
        title: c.title,
        date: c.recordDate,
        type: c.recordType,
        place: c.recordPlace,
        collectionId: e.collectionId,
        collection: e.collectionTitle,
        matched: terms.length ? terms : undefined,
        snippets: text ? snippetsAround(text, terms, opts.snippets ?? 3) : undefined,
        text: opts.includeText && text ? text.slice(0, opts.maxTextChars ?? 4000) : undefined,
        url: arkImageId(e.id) ? `${ORIGIN}/ark:/61903/3:1:${arkImageId(e.id)}` : undefined,
      });
    }),
    facets: opts.facets ? summarizeFacetGroups(data?.facets) : undefined,
  });
}

export interface CatalogQuery {
  place?: string;
  /** Exigir o local exato (sem os lugares dentro dele). */
  placeExact?: boolean;
  filters?: string;
  count?: number;
  offset?: number;
}

export function catalogQuery(q: CatalogQuery) {
  const params = new URLSearchParams({
    count: String(q.count ?? 20),
    offset: String(q.offset ?? 0),
    "m.defaultFacets": "on",
    "m.queryRequireDefault": "on",
  });
  if (q.place?.trim()) {
    params.append("q.place", q.place.trim());
    if (q.placeExact) params.append("q.place.exact", "on");
  }
  for (const [k, v] of new URLSearchParams(q.filters ?? "")) params.append(k, v);
  if (![...params.keys()].some((k) => k.startsWith("q."))) throw new Error("Informe ao menos o local (ou um filtro q.* em `filters`).");
  return Object.fromEntries(params);
}

/** Texto de campos do catálogo que vêm como string, lista ou objetos `{ value }`. */
function textOf(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("; ") || undefined;
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    return textOf(v.value ?? v.text ?? v.name ?? v.title);
  }
  return String(value);
}

/** Id do item de catálogo a partir da URL dele (ex.: `koha:248067`). */
export function catalogItemId(url?: string) {
  const last = url?.split(/[?#]/)[0]?.split("/").filter(Boolean).pop();
  return last ? decodeURIComponent(last) : undefined;
}

export function summarizeCatalogSearch(data: any, withFacets = false) {
  return clean({
    total: data?.totalHits as number | undefined,
    items: ((data?.searchHits ?? []) as any[]).map((h) => {
      const m = h.metadataHit?.metadata ?? {};
      const availability = [...new Set(((m.repositoryCalls ?? []) as any[]).map((r) => r.title).filter(Boolean))] as string[];
      return clean({
        id: catalogItemId(textOf(m.identifier)),
        title: textOf(m.title),
        creators: Array.isArray(m.creator) ? m.creator.map(textOf).filter(Boolean) : undefined,
        topics: ((m.properties ?? []) as any[]).filter((p) => String(p.type).endsWith("topic")).map((p) => p.value),
        availability: availability.length ? availability : undefined,
        online: availability.includes("Online") || undefined,
      });
    }),
    facets: withFacets ? summarizeFacetGroups(data?.facets) : undefined,
  });
}

/** Item do catálogo: descrição e os filmes (microfilme/filme digital) com o conteúdo de cada um. */
export function summarizeCatalogItem(id: string, data: any) {
  const src = data?.source ?? data ?? {};
  const films = ((src.film_note ?? []) as any[]).map((f) =>
    clean({
      contents: textOf(f.text)?.replace(/\s+/g, " ").trim(),
      dates: f.inclusive_dates || undefined,
      filmNumber: f.filmno || undefined,
      dgsNumber: f.digital_film_no || undefined,
      volume: f.volume || undefined,
      items: f.items || undefined,
      imageStart: f.item_image_start_no || undefined,
      digitalRights: f.digital_film_rights || undefined,
      indexed: f.fs_indexed || undefined,
      location: textOf(f.copy_location_ex?.copy_location_name ?? f.location) || undefined,
    }),
  );
  return clean({
    id,
    title: textOf(src.display_title ?? src.title),
    dates: textOf(src.inclusive_dates),
    authors: textOf(src.author),
    subjects: textOf(src.subject),
    availableOnline: textOf(src.available_online),
    notes: ((src.note ?? []) as any[]).map((n) => textOf(n.text)).filter(Boolean),
    films: films.length ? films : undefined,
    url: `${ORIGIN}/search/catalog/${encodeURIComponent(id)}`,
  });
}

/** Número de filme digital (DGS) com 9 dígitos, como o site usa (ex.: 4016084 → 004016084). */
export function normalizeDgs(value: string) {
  const digits = value.replace(/\D/g, "");
  if (!digits) throw new Error(`Número de filme digital inválido: "${value}".`);
  return digits.padStart(9, "0");
}

export function filmDataRequest(dgs: string) {
  return {
    type: "film-data",
    args: { dgsNum: dgs, state: { i: "0", imageOrFilmUrl: `/search/film/${dgs}`, viewMode: "i", selectedImageIndex: 0 }, locale: "pt" },
  };
}

export function summarizeFilm(dgs: string, data: any, offset = 0, count = 50) {
  const images = ((data?.images ?? []) as string[]).map(arkImageId);
  const page = images.slice(offset, offset + count).map((imageId, i) => ({ number: offset + i + 1, imageId }));
  return clean({
    dgsNumber: data?.dgsNum ?? dgs,
    totalImages: images.length,
    catalogs: ((data?.catalogs ?? []) as any[]).map((c) =>
      clean({ id: catalogItemId(c.path), title: textOf(c.data?.display_title ?? c.data?.title), dates: textOf(c.data?.inclusive_dates) }),
    ),
    images: page.length ? page : undefined,
    nextOffset: offset + count < images.length ? offset + count : undefined,
    url: `${ORIGIN}/search/film/${dgs}`,
  });
}
