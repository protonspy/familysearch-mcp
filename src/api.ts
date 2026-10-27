import { FS_ATOM, JSON_TYPE, FamilySearchClient } from "./client.js";
import {
  type AtomFeed,
  type Gedcomx,
  type GxPerson,
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
  placeSearch: "/platform/places/search",
} as const;

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
  constructor(readonly client: FamilySearchClient) {}

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
