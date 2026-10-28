import { BotChallengeError, FS_ATOM, JSON_TYPE, FamilySearchClient } from "./client.js";
import {
  type CatalogQuery,
  DISCOVERY_ROUTES,
  type FullTextQuery,
  GEDCOMX_JSON,
  catalogQuery,
  filmDataRequest,
  fullTextQuery,
  imageFolders,
  normalizeDgs,
  summarizeCatalogItem,
  summarizeCatalogSearch,
  summarizeFilm,
  summarizeFullText,
  summarizeWaypoint,
} from "./discovery.js";
import {
  type AtomFeed,
  type Gedcomx,
  type GxPerson,
  type GxSourceDescription,
  type PersonSummary,
  type SearchFacet,
  allNames,
  clean,
  parentsOf,
  personaArk,
  refId,
  summarizeCouple,
  summarizeFacts,
  summarizePerson,
} from "./gedcomx.js";
import { ImageStore, imageFilePath } from "./images.js";
import { type Region, parseRectangleRegion } from "./imaging.js";
import { type TextHit, type TextSearchOptions, TranscriptStore, pageText, searchPage } from "./transcript.js";

export interface BookTextQuery extends TextSearchOptions {
  terms: string[];
  collectionId?: string;
  waypointId?: string;
  imageIds?: string[];
  fromImage?: number;
  toImage?: number;
  maxImages?: number;
  maxHits?: number;
}

/**
 * Rotas do FamilySearch usadas pelo servidor, mapeadas a partir do tráfego do site
 * (www.familysearch.org) com uma sessão logada.
 */
export const ROUTES = {
  currentUser: "/platform/users/current",
  person: (pid: string) => `/platform/tree/persons/${pid}`,
  parents: (pid: string) => `/platform/tree/persons/${pid}/parents`,
  spouses: (pid: string) => `/platform/tree/persons/${pid}/spouses`,
  children: (pid: string) => `/platform/tree/persons/${pid}/children`,
  sources: (pid: string) => `/platform/tree/persons/${pid}/sources`,
  memories: (pid: string) => `/platform/tree/persons/${pid}/memories`,
  notes: (pid: string) => `/platform/tree/persons/${pid}/notes`,
  changes: (pid: string) => `/platform/tree/persons/${pid}/changes`,
  personMatches: (pid: string) => `/platform/tree/persons/${pid}/matches`,
  ancestry: "/platform/tree/ancestry",
  descendancy: "/platform/tree/descendancy",
  /** Busca na Árvore Familiar usada pela UI (/search/tree/results). */
  treeSearch: "/service/search/tree/v2/personas",
  /** Busca de registros históricos usada pela UI (/search/record/results). */
  recordSearch: "/service/search/hr/v2/personas",
  persona: (id: string) => `/platform/records/personas/${id}`,
  personaMatches: (id: string) => `/platform/records/personas/${id}/matches`,
  /** Entrada de registro (ark 1:2): o assento inteiro, com todas as pessoas e a região na imagem. */
  recordEntry: (id: string) => `/platform/records/records/${id}`,
  /** Metadados da imagem (ark 3:1): pasta, citação, posição no filme e links anterior/seguinte. */
  image: (id: string) => `/platform/records/images/3:1:${id}`,
  /** Entradas de registro indexadas nesta imagem. */
  imageRecords: (id: string) => `/platform/records/images/3:1:${id}/records`,
  imageFile: imageFilePath,
  placeSearch: "/platform/places/search",
} as const;

export type DocumentKind = "persona" | "record" | "image";

/** Identifica o tipo de id: persona (ark 1:1), entrada de registro (ark 1:2) ou imagem (ark 3:1). */
export function parseDocumentId(input: string): { kind: DocumentKind; id: string } {
  const value = input.trim();
  const ark = value.match(/\b(1:1|1:2|3:1):([A-Z0-9]+(?:-[A-Z0-9]+)+)/i);
  if (ark) return { kind: ark[1] === "1:1" ? "persona" : ark[1] === "1:2" ? "record" : "image", id: ark[2].toUpperCase() };
  const id = value.toUpperCase();
  if (/^[A-Z0-9]{4}-[A-Z0-9]{2,4}$/.test(id)) return { kind: "persona", id };
  // Ids de imagem têm 3 ou 4 blocos (ex.: S3HY-6DWJ-XX, 3Q9M-C95G-39YP-C).
  if (/^[A-Z0-9]{4}(?:-[A-Z0-9]{1,4}){2,3}$/.test(id)) return { kind: "image", id };
  throw new Error(`Id de documento não reconhecido: "${input}". Use o id de um registro (ex.: QLZ1-89HC) ou um ark 1:1, 1:2 ou 3:1.`);
}

const arkId = (url: string | undefined, prefix: "1:1" | "1:2" | "3:1") => url?.match(new RegExp(`${prefix}:([A-Z0-9-]+)`, "i"))?.[1];

/** Limites aceitos pela API (valores maiores retornam HTTP 400). */
export const ANCESTRY_MAX_GENERATIONS = 8;
export const DESCENDANCY_MAX_GENERATIONS = 4;

export interface SearchQuery {
  givenName?: string;
  surname?: string;
  sex?: "Male" | "Female";
  /** Ano ("1900") ou intervalo ("1900-1920"). */
  birthLikeDate?: string;
  birthLikePlace?: string;
  deathLikeDate?: string;
  deathLikePlace?: string;
  marriageLikeDate?: string;
  marriageLikePlace?: string;
  residenceDate?: string;
  residencePlace?: string;
  anyPlace?: string;
  anyDate?: string;
  fatherGivenName?: string;
  fatherSurname?: string;
  motherGivenName?: string;
  motherSurname?: string;
  spouseGivenName?: string;
  spouseSurname?: string;
  /** Exige correspondência exata em nome e sobrenome. */
  exactNames?: boolean;
  /** Parâmetros brutos extras, ex.: o `params` de uma faceta (`f.collectionId=1234`). */
  filters?: string;
}

export interface SearchHit {
  id: string;
  score?: number;
  confidence?: number;
  person: PersonSummary;
  relatives?: { relation: string; name: string; id?: string; lifespan?: string }[];
  recordUrl?: string;
  collection?: string;
}

export class FamilySearchApi {
  constructor(
    readonly client: FamilySearchClient,
    readonly images = new ImageStore(client),
    readonly texts = new TranscriptStore(client),
  ) {}

  private summarize = (p: GxPerson) => summarizePerson(p, this.client.baseUrl);

  async currentUser() {
    const data = await this.client.get<{ users?: any[] }>(ROUTES.currentUser);
    const user = data?.users?.[0];
    if (!user) return null;
    return clean({
      id: user.id,
      contactName: user.contactName,
      displayName: user.displayName,
      treePersonId: user.personId,
      preferredLanguage: user.preferredLanguage,
    });
  }

  async getPerson(pid: string) {
    const data = await this.client.get<Gedcomx>(ROUTES.person(pid));
    const person = data?.persons?.find((p) => p.id === pid) ?? data?.persons?.[0];
    if (!person) return null;
    return {
      ...this.summarize(person),
      // O FamilySearch redireciona ids mesclados para o id sobrevivente.
      mergedInto: person.id !== pid ? person.id : undefined,
      names: allNames(person),
      facts: summarizeFacts(person.facts),
    };
  }

  /** Pais, cônjuges e filhos de uma pessoa, agrupados por família. */
  async getFamily(pid: string, { includeParents = true } = {}) {
    const [parents, spouses, children] = await Promise.all([
      includeParents ? this.client.get<Gedcomx>(ROUTES.parents(pid)) : null,
      this.client.get<Gedcomx>(ROUTES.spouses(pid)),
      this.client.get<Gedcomx>(ROUTES.children(pid)),
    ]);

    const people = new Map<string, PersonSummary>();
    for (const doc of [parents, spouses, children]) {
      for (const p of doc?.persons ?? []) people.set(p.id, this.summarize(p));
    }
    const ref = (id?: string) => (id ? clean({ id, name: people.get(id)?.name ?? id, lifespan: people.get(id)?.lifespan }) : undefined);

    const parentFamilies = (parents?.childAndParentsRelationships ?? [])
      .map(parentsOf)
      .filter((r) => r.child === pid)
      .map((r) => clean({ parent1: ref(r.parent1), parent2: ref(r.parent2) }));

    const childRels = (children?.childAndParentsRelationships ?? []).map(parentsOf).filter((r) => r.parent1 === pid || r.parent2 === pid);
    const spouseRels = (spouses?.relationships ?? []).map(summarizeCouple).filter((r) => r.person1 === pid || r.person2 === pid);

    const spouseIds = new Set(spouseRels.map((r) => (r.person1 === pid ? r.person2 : r.person1)).filter((id): id is string => Boolean(id)));
    for (const r of childRels) {
      const other = r.parent1 === pid ? r.parent2 : r.parent1;
      if (other) spouseIds.add(other);
    }

    const families: { spouse?: ReturnType<typeof ref>; marriage?: PersonSummary["birth"]; children: NonNullable<ReturnType<typeof ref>>[] }[] = [
      ...spouseIds,
    ].map((spouseId) => {
      const couple = spouseRels.find((r) => r.person1 === spouseId || r.person2 === spouseId);
      return clean({
        spouse: ref(spouseId),
        marriage: couple?.marriage,
        children: childRels.filter((r) => r.parent1 === spouseId || r.parent2 === spouseId).map((r) => ref(r.child)!),
      });
    });
    const singleParent = childRels.filter((r) => !r.parent1 || !r.parent2).map((r) => ref(r.child)!);
    if (singleParent.length) families.push({ children: singleParent });

    return { person: ref(pid)!, parents: parentFamilies, families, persons: [...people.values()] };
  }

  /** Ascendência em numeração Ahnentafel (1 = pessoa, 2 = pai, 3 = mãe, ...). */
  async getAncestry(pid: string, generations: number) {
    const data = await this.client.get<Gedcomx>(ROUTES.ancestry, {
      query: { person: pid, generations: clamp(generations, 1, ANCESTRY_MAX_GENERATIONS), personDetails: true },
    });
    // A resposta também traz o cônjuge da pessoa como "1-S"; só interessam os números inteiros.
    return (data?.persons ?? [])
      .filter((p) => /^\d+$/.test(p.display?.ascendancyNumber ?? ""))
      .map((p) => ({ ahnentafel: Number(p.display!.ascendancyNumber), person: this.summarize(p) }))
      .sort((a, b) => a.ahnentafel - b.ahnentafel);
  }

  /**
   * Descendência com numeração d'Aboville do FamilySearch: `1.2` é o 2º filho de 1 com o cônjuge `1-S1`,
   * `1-S2.1` é o 1º filho de 1 com o cônjuge `1-S2`.
   */
  async getDescendancy(pid: string, generations: number) {
    const data = await this.client.get<Gedcomx>(ROUTES.descendancy, {
      query: { person: pid, generations: clamp(generations, 1, DESCENDANCY_MAX_GENERATIONS), personDetails: true },
    });
    return (data?.persons ?? [])
      .filter((p) => p.display?.descendancyNumber)
      .map((p) => ({ number: p.display!.descendancyNumber!, person: this.summarize(p) }))
      .sort((a, b) => compareDescendancy(a.number, b.number));
  }

  async searchTree(query: SearchQuery, count = 20, offset = 0) {
    const feed = await this.client.get<AtomFeed>(ROUTES.treeSearch + toQueryString(query), {
      accept: JSON_TYPE,
      query: { count, offset, "m.defaultFacets": "on" },
    });
    return this.parseSearch(feed, "tree");
  }

  async searchRecords(query: SearchQuery, count = 20, offset = 0, collectionId?: string) {
    const feed = await this.client.get<AtomFeed>(ROUTES.recordSearch + toQueryString(query), {
      accept: JSON_TYPE,
      query: {
        count,
        offset,
        "m.defaultFacets": "on",
        "m.queryRequireDefault": "on",
        "m.facetNestCollectionInCategory": "on",
        "f.collectionId": collectionId,
      },
    });
    return this.parseSearch(feed, "records");
  }

  private parseSearch(feed: AtomFeed | null, kind: "tree" | "records") {
    const hits: SearchHit[] = (feed?.entries ?? []).map((entry) => {
      const gx = entry.content?.gedcomx ?? {};
      const persons = gx.persons ?? [];
      const main =
        persons.find((p) => p.id === entry.id) ?? persons.find((p) => p.principal) ?? persons[0] ?? ({ id: entry.id ?? "?" } as GxPerson);
      const byId = new Map(persons.map((p) => [p.id, p]));
      const relatives: NonNullable<SearchHit["relatives"]> = [];
      const addRelative = (relation: string, id?: string) => {
        if (!id || id === main.id) return;
        const p = byId.get(id);
        const summary = this.summarize(p ?? { id });
        // Em registros o papel vem pronto (Father, Mother, Spouse...); na árvore é inferido da relação.
        const role = p?.display?.role && !/^(Other|Principal)$/i.test(p.display.role) ? p.display.role : relation;
        relatives.push(clean({ relation: role, id: kind === "tree" ? id : undefined, name: summary.name, lifespan: summary.lifespan }));
      };

      for (const rel of gx.relationships ?? []) {
        const a = refId(rel.person1);
        const b = refId(rel.person2);
        const type = rel.type?.split("/").pop();
        if (a === main.id) addRelative(type === "Couple" ? "spouse" : type === "ParentChild" ? "child" : (type ?? "related"), b);
        else if (b === main.id) addRelative(type === "Couple" ? "spouse" : type === "ParentChild" ? "parent" : (type ?? "related"), a);
      }
      for (const cap of gx.childAndParentsRelationships ?? []) {
        const r = parentsOf(cap);
        if (r.child === main.id) [r.parent1, r.parent2].forEach((p) => addRelative("parent", p));
        else if (r.parent1 === main.id || r.parent2 === main.id) addRelative("child", r.child);
      }

      const collection = gx.sourceDescriptions?.find((s) => s.resourceType?.endsWith("Collection"))?.titles?.[0]?.value;
      return clean({
        id: entry.id ?? main.id,
        score: entry.score,
        confidence: entry.confidence,
        person: this.summarize(main),
        relatives: dedupeRelatives(relatives),
        recordUrl: kind === "records" ? (personaArk(main) ?? `${this.client.baseUrl}/ark:/61903/1:1:${entry.id}`) : undefined,
        collection,
      });
    });
    return { total: feed?.results ?? hits.length, index: feed?.index ?? 0, hits, facets: summarizeFacets(feed?.facets) };
  }

  async getPersonSources(pid: string) {
    const data = await this.client.get<Gedcomx>(ROUTES.sources(pid));
    return (data?.sourceDescriptions ?? []).map((s) =>
      clean({
        id: s.id,
        title: s.titles?.[0]?.value,
        citation: s.citations?.[0]?.value,
        url: s.about,
        notes: s.notes?.map((n) => n.text).filter(Boolean).join("\n") || undefined,
      }),
    );
  }

  async getPersonMemories(pid: string) {
    const data = await this.client.get<Gedcomx>(ROUTES.memories(pid));
    return (data?.sourceDescriptions ?? []).map((s) =>
      clean({ id: s.id, title: s.titles?.[0]?.value, description: s.descriptions?.[0]?.value, mediaType: s.mediaType, url: s.about }),
    );
  }

  async getPersonNotes(pid: string) {
    const data = await this.client.get<{ persons?: { notes?: { id?: string; subject?: string; text?: string }[] }[] }>(ROUTES.notes(pid));
    return (data?.persons?.[0]?.notes ?? []).map((n) => clean({ id: n.id, subject: n.subject, text: n.text }));
  }

  async getPersonChanges(pid: string, count = 20) {
    // O endpoint ignora `count` e devolve o histórico inteiro; o corte é feito aqui.
    const feed = await this.client.get<any>(ROUTES.changes(pid), { accept: FS_ATOM });
    const entries: any[] = feed?.entries ?? [];
    return {
      total: entries.length,
      changes: entries.slice(0, count).map((e) =>
        clean({
          title: e.title as string | undefined,
          updated: e.updated ? new Date(e.updated).toISOString() : undefined,
          contributor: e.contributors?.[0]?.name as string | undefined,
          reason: e.changeInfo?.[0]?.reason as string | undefined,
        }),
      ),
    };
  }

  /** Dicas de registros (record hints) ou possíveis duplicatas de uma pessoa da árvore. */
  async getPersonMatches(pid: string, kind: "records" | "tree", count = 20) {
    const feed = await this.client.get<AtomFeed>(ROUTES.personMatches(pid), {
      accept: FS_ATOM,
      query: { collection: kind, status: kind === "records" ? "pending" : undefined, includeSummary: true, count },
    });
    return this.parseSearch(feed, kind);
  }

  /** Lê um registro histórico (persona) por id (ex.: `ZWC8-M9ZM`) ou URL ark, com as pessoas da árvore ligadas a ele. */
  async getRecord(idOrArk: string) {
    const id = idOrArk.match(/1:1:([A-Z0-9-]+)/i)?.[1] ?? idOrArk.trim();
    const [data, attached] = await Promise.all([
      this.client.get<Gedcomx>(ROUTES.persona(id)),
      this.client.get<AtomFeed>(ROUTES.personaMatches(id), {
        accept: FS_ATOM,
        query: { collection: "tree", status: "accepted", includeSummary: true },
      }),
    ]);
    if (!data) return null;
    const persons = data.persons ?? [];
    const principal = persons.find((p) => p.principal) ?? persons.find((p) => personaArk(p)?.endsWith(id)) ?? persons[0];
    const name = (pid?: string) => (pid ? (this.summarize(persons.find((p) => p.id === pid) ?? { id: pid }).name ?? pid) : undefined);
    return {
      id,
      url: `${this.client.baseUrl}/ark:/61903/1:1:${id}`,
      principal: principal && { ...this.summarize(principal), facts: summarizeFacts(principal.facts) },
      persons: persons.map((p) => clean({ ...this.summarize(p), role: p.display?.role, url: undefined })),
      relationships: (data.relationships ?? []).map((r) => ({
        type: r.type?.split("/").pop(),
        person1: name(refId(r.person1)),
        person2: name(refId(r.person2)),
      })),
      source: (data.sourceDescriptions ?? [])
        .filter((s) => s.titles?.length || s.citations?.length)
        .map((s) => clean({ title: s.titles?.[0]?.value, citation: s.citations?.[0]?.value, url: s.about })),
      attachedTreePersons: this.parseSearch(attached, "tree").hits.map((h) => h.person),
    };
  }

  /**
   * Localiza a imagem de um documento a partir de uma persona (1:1), entrada (1:2) ou da própria imagem (3:1),
   * com a região do assento na página quando o indexador a marcou.
   */
  async locateDocument(input: string) {
    const ref = parseDocumentId(input);
    if (ref.kind === "image") return { imageId: ref.id } as { imageId: string; region?: Region; recordId?: string; title?: string };

    const data = await this.client.get<Gedcomx>(ref.kind === "persona" ? ROUTES.persona(ref.id) : ROUTES.recordEntry(ref.id));
    if (!data) throw new Error("Registro não encontrado.");
    const sds = data.sourceDescriptions ?? [];
    const record = sds.find((s) => s.resourceType?.endsWith("/Record"));
    const link = imageLink(record, sds) ?? { image: sds.find((s) => s.resourceType?.endsWith("/DigitalArtifact")), region: undefined };
    const imageId = arkId(link.image?.about, "3:1");
    if (!imageId) throw new Error("Este registro não tem imagem associada no FamilySearch (existe só o índice).");
    return clean({ imageId, region: link.region, recordId: arkId(record?.about, "1:2"), title: record?.titles?.[0]?.value });
  }

  /** Metadados de uma imagem: pasta no filme, posição (imagem N de M), citação, vizinhas e se a conta pode vê-la. */
  async getImageInfo(imageId: string) {
    const data = await this.client.get<Gedcomx>(ROUTES.image(imageId));
    if (!data) throw new Error(`Imagem 3:1:${imageId} não encontrada.`);
    const sds = data.sourceDescriptions ?? [];
    const byId = new Map(sds.map((s) => [s.id, s]));
    const main = sds.find((s) => s.resourceType?.endsWith("/DigitalArtifact")) ?? sds[0];

    // A imagem aponta para a pasta que a contém, que aponta para a pasta acima, até a coleção.
    const folders: string[] = [];
    for (let sd = byId.get(main?.componentOf?.description?.replace(/^#/, "")); sd && folders.length < 10; ) {
      const title = sd.titles?.[0]?.value;
      if (title && title !== folders[0]) folders.unshift(title);
      sd = byId.get(sd.componentOf?.description?.replace(/^#/, ""));
    }
    const collection = main?.titles?.[0]?.value?.split("; http")[0];
    if (collection && folders[0] !== collection) folders.unshift(collection);
    const browse = imageFolders(data);

    return clean({
      imageId,
      url: `${this.client.baseUrl}/ark:/61903/3:1:${imageId}`,
      viewable: Boolean(data.links?.["image-deepzoom"] ?? data.links?.["image-stream-image-dist"]),
      imageNumber: data.links?.self?.offset,
      totalImages: data.links?.self?.results,
      folderPath: folders.join(" > ") || undefined,
      collectionId: browse.collectionId,
      folders: browse.folders.some((f) => f.waypointId) ? browse.folders : undefined,
      citation: main?.citations?.[0]?.value?.trim(),
      previousImageId: arkId(data.links?.prev?.href, "3:1"),
      nextImageId: arkId(data.links?.next?.href, "3:1"),
    });
  }

  /** Anda `step` imagens para frente (positivo) ou para trás (negativo) no filme. */
  async stepImage(imageId: string, step: number) {
    let current = imageId;
    for (let i = 0; i < Math.abs(step); i++) {
      const info = await this.getImageInfo(current);
      const next = step > 0 ? info.nextImageId : info.previousImageId;
      if (!next) throw new Error(`Não há imagem ${step > 0 ? "seguinte" : "anterior"} a 3:1:${current} nesta pasta.`);
      current = next;
    }
    return current;
  }

  /** Entradas indexadas em uma imagem, cada uma com evento, pessoas, papéis e região na página. */
  async getImageIndex(imageId: string, limit = 25) {
    const data = await this.client.get<Gedcomx>(ROUTES.imageRecords(imageId));
    const ids = (data?.sourceDescriptions ?? [])
      .filter((s) => s.resourceType?.endsWith("/Record"))
      .map((s) => s.id ?? arkId(s.about, "1:2"))
      .filter((id): id is string => Boolean(id));
    const records = [];
    for (const id of ids.slice(0, limit)) records.push(await this.getRecordEntry(id));
    return { total: ids.length, records };
  }

  /** Entrada de registro (ark 1:2): o evento e todas as pessoas do assento, com papel em relação ao principal. */
  async getRecordEntry(id: string) {
    const data = await this.client.get<Gedcomx>(ROUTES.recordEntry(id));
    if (!data) throw new Error(`Entrada de registro 1:2:${id} não encontrada.`);
    const persons = data.persons ?? [];
    const principal = persons.find((p) => p.principal) ?? persons[0];
    const roleOf = (p: GxPerson) => {
      if (p === principal) return "Principal";
      if (p.display?.role && !/^(Other|Principal)$/i.test(p.display.role)) return p.display.role;
      for (const r of data.relationships ?? []) {
        const a = refId(r.person1);
        const b = refId(r.person2);
        if (!principal || ![a, b].includes(principal.id) || ![a, b].includes(p.id)) continue;
        const type = r.type?.split("/").pop();
        if (type === "Couple") return "Spouse";
        if (type === "ParentChild") {
          if (a === principal.id) return "Child";
          const gender = p.gender?.type?.split("/").pop();
          return gender === "Male" ? "Father" : gender === "Female" ? "Mother" : "Parent";
        }
      }
      return "Other";
    };
    const sds = data.sourceDescriptions ?? [];
    const record = sds.find((s) => s.resourceType?.endsWith("/Record"));
    const link = imageLink(record, sds);
    return clean({
      recordId: id,
      title: record?.titles?.[0]?.value,
      facts: principal ? summarizeFacts(principal.facts) : undefined,
      persons: persons.map((p) => clean({ role: roleOf(p), name: this.summarize(p).name, personaId: arkId(personaArk(p), "1:1") })),
      region: link?.region,
    });
  }

  /** Imagem em resolução total (JPEG) e de onde ela veio (memória, cache, Downloads ou rede). */
  async getImageBytes(imageId: string) {
    return this.images.get(imageId);
  }

  /**
   * Navega as pastas de imagens de uma coleção (local > paróquia/cartório > livro > imagens).
   * Sem `waypointId`, lista as pastas de primeiro nível da coleção.
   */
  async browseImages(collectionId: string, waypointId?: string, offset = 0, count = 50) {
    const path = waypointId ? DISCOVERY_ROUTES.waypoint(waypointId) : DISCOVERY_ROUTES.collectionWaypoints(collectionId);
    const data = await this.client.get<Gedcomx>(path, { accept: GEDCOMX_JSON, query: waypointId ? { cc: collectionId } : undefined });
    if (!data) throw new Error("Pasta não encontrada.");
    return { collectionId, ...summarizeWaypoint(data, offset, count) };
  }

  /** Transcrição automática (IA) de uma página, linha a linha, com a posição de cada linha na imagem. */
  async getImageText(documentId: string, withLines = false) {
    const { imageId } = await this.locateDocument(documentId);
    const { page, source } = await this.texts.get(imageId);
    if (!page) throw new Error(`O FamilySearch não tem transcrição automática para a imagem 3:1:${imageId}.`);
    return clean({
      imageId,
      url: `${this.client.baseUrl}/ark:/61903/3:1:${imageId}`,
      source,
      text: pageText(page),
      lines: withLines ? page.blocks.flat() : undefined,
    });
  }

  /**
   * Procura nomes nas transcrições de todas as páginas de um livro (pasta de imagens) ou de uma lista de imagens,
   * tolerando grafias e erros de leitura. Devolve os trechos com a região de cada um na página.
   */
  async searchBookText(q: BookTextQuery) {
    let title: string | undefined;
    let images: { number: number; imageId: string }[];
    if (q.waypointId) {
      if (!q.collectionId) throw new Error("Informe o collectionId junto com o waypointId.");
      const book = await this.browseImages(q.collectionId, q.waypointId, 0, 100_000);
      if (!book.images?.length) throw new Error(`A pasta "${book.title}" não tem imagens (é uma pasta de pastas): escolha um livro dentro dela.`);
      title = book.title;
      images = book.images.filter((i): i is { number: number; imageId: string } => Boolean(i.imageId));
    } else if (q.imageIds?.length) {
      images = q.imageIds.map((id, i) => ({ number: i + 1, imageId: id.replace(/^.*3:1:/, "").replace(/[?#].*$/, "") }));
    } else throw new Error("Informe um livro (collectionId + waypointId) ou uma lista de imageIds.");

    const from = Math.max(1, q.fromImage ?? 1);
    const last = Math.min(images.length, q.toImage ?? images.length, from + (q.maxImages ?? 150) - 1);
    const hits: TextHit[] = [];
    const withoutText: number[] = [];
    const failed: { image: number; error: string }[] = [];
    let downloaded = 0;
    let stoppedAt: number | undefined;
    for (const { number, imageId } of images.slice(from - 1, last)) {
      try {
        const { page, source } = await this.texts.get(imageId);
        if (source === "rede") downloaded++;
        if (!page) withoutText.push(number);
        else hits.push(...searchPage(page, q.terms, q, number));
      } catch (err) {
        // Verificação anti-robô: parar e devolver o que já foi lido (o cache guarda as páginas baixadas).
        if (err instanceof BotChallengeError) {
          stoppedAt = number;
          failed.push({ image: number, error: err.message });
          break;
        }
        failed.push({ image: number, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const searchedTo = stoppedAt ? stoppedAt - 1 : last;
    hits.sort((a, b) => b.terms.length - a.terms.length || (a.imageNumber ?? 0) - (b.imageNumber ?? 0));
    return clean({
      book: title,
      totalImages: images.length,
      searched: `${from}-${searchedTo}`,
      downloaded,
      withoutText: withoutText.length ? withoutText : undefined,
      failed: failed.length ? failed : undefined,
      nextImage: searchedTo < images.length && (q.toImage === undefined || searchedTo < q.toImage) ? searchedTo + 1 : undefined,
      totalHits: hits.length,
      hits: hits.slice(0, q.maxHits ?? 30),
    });
  }

  /** Busca nas transcrições automáticas de imagens (texto completo), inclusive de livros não indexados. */
  async searchFullText(query: FullTextQuery, opts: { includeText?: boolean; maxTextChars?: number; facets?: boolean } = {}) {
    const data = await this.client.get<any>(DISCOVERY_ROUTES.fullTextSearch, { accept: JSON_TYPE, query: fullTextQuery(query) });
    return summarizeFullText(data, opts);
  }

  async searchCatalog(query: CatalogQuery, facets = false) {
    const data = await this.client.get<any>(DISCOVERY_ROUTES.catalogSearch, { accept: JSON_TYPE, query: catalogQuery(query) });
    return summarizeCatalogSearch(data, facets);
  }

  async getCatalogItem(id: string) {
    const itemId = id.trim().replace(/^.*\/catalog\/(item\/|info\/)?/, "");
    const data = await this.client.get<any>(DISCOVERY_ROUTES.catalogItem(itemId), { accept: JSON_TYPE });
    if (!data) throw new Error(`Item de catálogo ${itemId} não encontrado.`);
    return summarizeCatalogItem(itemId, data);
  }

  /** Imagens de um filme digital (DGS), na ordem do filme, com os itens de catálogo que ele contém. */
  async getFilm(dgsNumber: string, offset = 0, count = 50) {
    const dgs = normalizeDgs(dgsNumber);
    const data = await this.client.post<any>(DISCOVERY_ROUTES.filmData, filmDataRequest(dgs), { accept: JSON_TYPE });
    if (!data?.images) throw new Error(`Filme digital ${dgs} não encontrado ou sem imagens acessíveis.`);
    return summarizeFilm(dgs, data, offset, count);
  }

  async searchPlaces(name: string, count = 10) {
    const feed = await this.client.get<any>(ROUTES.placeSearch, { accept: FS_ATOM, query: { q: `name:"${name}"`, count } });
    return (feed?.entries ?? []).map((e: any) => {
      const place = e.content?.gedcomx?.places?.[0] ?? {};
      return clean({
        id: (place.id ?? e.id) as string | undefined,
        name: (place.display?.fullName ?? place.names?.[0]?.value) as string | undefined,
        type: place.display?.type as string | undefined,
        latitude: place.latitude as number | undefined,
        longitude: place.longitude as number | undefined,
        score: e.score as number | undefined,
      });
    });
  }
}

/** Imagem referenciada pelo registro e a região do assento nela (`RectangleRegion` do indexador), se houver. */
function imageLink(record: GxSourceDescription | undefined, sds: GxSourceDescription[]) {
  for (const src of record?.sources ?? []) {
    const id = src.descriptionId ?? src.description?.replace(/^#/, "");
    const image = sds.find((s) => s.id === id && s.resourceType?.endsWith("/DigitalArtifact"));
    if (!image) continue;
    const region = parseRectangleRegion(src.qualifiers?.find((q) => q.name?.endsWith("RectangleRegion"))?.value);
    return { image, region };
  }
  return undefined;
}

const NAME_KEYS = ["givenName", "surname"] as const;
const DATE_KEYS = ["birthLikeDate", "deathLikeDate", "marriageLikeDate", "residenceDate", "anyDate"] as const;
const TEXT_KEYS = [
  "sex",
  "birthLikePlace",
  "deathLikePlace",
  "marriageLikePlace",
  "residencePlace",
  "anyPlace",
  "fatherGivenName",
  "fatherSurname",
  "motherGivenName",
  "motherSurname",
  "spouseGivenName",
  "spouseSurname",
] as const;

/** Monta a query string no formato da busca do site (`q.*`, datas com `.from`/`.to`, `.exact=on`). */
export function toQueryString(query: SearchQuery) {
  const params = new URLSearchParams();
  for (const key of [...NAME_KEYS, ...TEXT_KEYS]) {
    const value = query[key]?.trim();
    if (!value) continue;
    params.append(`q.${key}`, value);
    if (query.exactNames && (NAME_KEYS as readonly string[]).includes(key)) params.append(`q.${key}.exact`, "on");
  }
  for (const key of DATE_KEYS) {
    const range = parseYearRange(query[key]);
    if (!range) continue;
    params.append(`q.${key}.from`, range.from);
    params.append(`q.${key}.to`, range.to);
  }
  if ([...params.keys()].length === 0) throw new Error("Informe ao menos um critério de busca (ex.: givenName, surname).");
  for (const [k, v] of new URLSearchParams(query.filters ?? "")) params.append(k, v);
  return `?${params.toString()}`;
}

export function parseYearRange(value?: string) {
  const years = value?.match(/\d{3,4}/g);
  if (!years?.length) return undefined;
  return { from: years[0], to: years[1] ?? years[0] };
}

function summarizeFacets(facets?: SearchFacet[]) {
  if (!facets?.length) return undefined;
  return facets
    .map((group) => ({
      name: group.displayName,
      options: (group.facets ?? []).slice(0, 25).map((f) => clean({ name: f.displayName, count: f.count, params: f.params })),
    }))
    .filter((g) => g.options.length);
}

function dedupeRelatives(list: NonNullable<SearchHit["relatives"]>) {
  const seen = new Set<string>();
  const out = list.filter((r) => {
    const key = `${r.relation}:${r.id ?? r.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return out.length ? out : undefined;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.trunc(n)));

/** Ordena números d'Aboville: pessoa, cônjuges e então filhos na ordem. */
export function compareDescendancy(a: string, b: string) {
  const split = (s: string) => s.split(/(?=[.-])/);
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const sa = pa[i].startsWith("-S");
    const sb = pb[i].startsWith("-S");
    if (sa !== sb) return sa ? -1 : 1;
    return Number(pa[i].replace(/\D/g, "")) - Number(pb[i].replace(/\D/g, ""));
  }
  return 0;
}
