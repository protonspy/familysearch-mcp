import { ANCESTRY_MAX_GENERATIONS, DESCENDANCY_MAX_GENERATIONS, type FamilySearchApi } from "./api.js";
import type { EventSummary, PersonSummary } from "./gedcomx.js";

export interface Family {
  id: string;
  parents: string[];
  children: Set<string>;
  marriage?: EventSummary;
}

/** Árvore local montada a partir do FamilySearch: pessoas + famílias (casal e filhos). */
export class FamilyTree {
  readonly persons = new Map<string, PersonSummary>();
  readonly families = new Map<string, Family>();
  /** Números Ahnentafel relativos à raiz (uma pessoa pode ter vários em caso de endogamia). */
  readonly ahnentafel = new Map<string, number[]>();
  readonly createdAt = new Date();

  constructor(
    readonly id: string,
    readonly rootId: string,
  ) {}

  addPerson(person: PersonSummary) {
    const existing = this.persons.get(person.id);
    this.persons.set(person.id, existing ? { ...existing, ...person } : person);
  }

  /** Cria (ou reaproveita) a família do casal e opcionalmente adiciona um filho. */
  link(parentA: string | undefined, parentB: string | undefined, child?: string, marriage?: EventSummary) {
    const parents = [parentA, parentB].filter((p): p is string => Boolean(p)).sort();
    if (parents.length === 0) return undefined;
    const id = parents.join("+");
    let family = this.families.get(id);
    if (!family) {
      family = { id, parents, children: new Set() };
      this.families.set(id, family);
    }
    if (child) family.children.add(child);
    if (marriage) family.marriage = marriage;
    return family;
  }

  parentsOf(pid: string) {
    return [...this.families.values()].filter((f) => f.children.has(pid));
  }

  familiesAsParent(pid: string) {
    return [...this.families.values()].filter((f) => f.parents.includes(pid));
  }

  stats() {
    const generations = Math.max(0, ...[...this.ahnentafel.values()].flat().map(generationOf));
    return { treeId: this.id, rootId: this.rootId, persons: this.persons.size, families: this.families.size, ancestorGenerations: generations };
  }
}

export const generationOf = (ahnentafel: number) => Math.floor(Math.log2(ahnentafel));

export interface BuildOptions {
  ancestorGenerations: number;
  descendantGenerations: number;
  maxPersons: number;
  onProgress?: (message: string) => void;
}

export class TreeBuilder {
  constructor(private readonly api: FamilySearchApi) {}

  /**
   * Busca ascendentes em blocos de até 8 gerações (limite do endpoint de ancestry),
   * reiniciando a partir dos ancestrais da última geração de cada bloco.
   */
  async addAncestors(tree: FamilyTree, rootId: string, generations: number, opts: Pick<BuildOptions, "maxPersons" | "onProgress">) {
    let frontier = [{ pid: rootId, number: 1 }];
    let remaining = generations;

    while (remaining > 0 && frontier.length > 0) {
      const chunk = Math.min(remaining, ANCESTRY_MAX_GENERATIONS);
      const next: typeof frontier = [];

      for (const start of frontier) {
        if (tree.persons.size >= opts.maxPersons) return;
        const list = await this.api.getAncestry(start.pid, chunk);
        const local = new Map<number, string>();
        for (const { ahnentafel: m, person } of list) {
          local.set(m, person.id);
          tree.addPerson(person);
          const g = generationOf(m);
          const global = start.number * 2 ** g + (m - 2 ** g);
          const numbers = tree.ahnentafel.get(person.id) ?? [];
          if (!numbers.includes(global)) tree.ahnentafel.set(person.id, [...numbers, global]);
          if (g === chunk && m > 1) next.push({ pid: person.id, number: global });
        }
        for (const [m, child] of local) {
          const father = local.get(2 * m);
          const mother = local.get(2 * m + 1);
          if (father || mother) tree.link(father, mother, child);
        }
        opts.onProgress?.(`Ascendência de ${start.pid}: ${list.length} pessoas (total ${tree.persons.size})`);
      }

      remaining -= chunk;
      frontier = next;
    }
  }

  /**
   * Busca descendentes em blocos de até 4 gerações (limite do endpoint de descendancy),
   * reiniciando a partir dos descendentes da última geração de cada bloco.
   */
  async addDescendants(tree: FamilyTree, rootId: string, generations: number, opts: Pick<BuildOptions, "maxPersons" | "onProgress">) {
    const visited = new Set<string>();
    let frontier = [rootId];
    let remaining = generations;

    while (remaining > 0 && frontier.length > 0) {
      const chunk = Math.min(remaining, DESCENDANCY_MAX_GENERATIONS);
      const next: string[] = [];

      for (const start of frontier) {
        if (visited.has(start)) continue;
        visited.add(start);
        if (tree.persons.size >= opts.maxPersons) return;

        const list = await this.api.getDescendancy(start, chunk);
        const byNumber = new Map(list.map(({ number, person }) => [number, person.id]));
        for (const { number, person } of list) {
          tree.addPerson(person);
          const spouseOf = number.match(/^(.*)-S\d+$/)?.[1];
          if (spouseOf) {
            tree.link(byNumber.get(spouseOf), person.id);
            continue;
          }
          const dot = number.lastIndexOf(".");
          if (dot < 0) continue;
          // "1.2" é filho de 1 com o cônjuge "1-S1"; "1-S2.1" é filho de 1 com o cônjuge "1-S2".
          const prefix = number.slice(0, dot);
          const viaSpouse = prefix.match(/^(.*)-S\d+$/)?.[1];
          const parent = byNumber.get(viaSpouse ?? prefix);
          const spouse = byNumber.get(viaSpouse ? prefix : `${prefix}-S1`);
          tree.link(parent, spouse, person.id);
          if (number.split(".").length - 1 === chunk) next.push(person.id);
        }
        opts.onProgress?.(`Descendência de ${start}: ${list.length} pessoas (total ${tree.persons.size})`);
      }

      remaining -= chunk;
      frontier = next;
    }
  }

  async build(tree: FamilyTree, opts: BuildOptions) {
    const root = await this.api.getPerson(tree.rootId);
    if (root) tree.addPerson(root);
    if (!tree.ahnentafel.has(tree.rootId)) tree.ahnentafel.set(tree.rootId, [1]);
    if (opts.ancestorGenerations > 0) await this.addAncestors(tree, tree.rootId, opts.ancestorGenerations, opts);
    if (opts.descendantGenerations > 0) await this.addDescendants(tree, tree.rootId, opts.descendantGenerations, opts);
    return tree;
  }
}

// ---------------------------------------------------------------------------
// Parentesco entre duas pessoas via ancestral comum
// ---------------------------------------------------------------------------

export interface RelationshipResult {
  found: boolean;
  personA: PersonSummary;
  personB: PersonSummary;
  /** "B é ___ de A" */
  label?: string;
  labelEn?: string;
  commonAncestors?: PersonSummary[];
  generationsFromA?: number;
  generationsFromB?: number;
  pathFromA?: PersonSummary[];
  pathFromB?: PersonSummary[];
  searchedGenerations: number;
}

export async function findRelationship(api: FamilySearchApi, a: string, b: string, generations: number): Promise<RelationshipResult> {
  const [ancA, ancB] = [await api.getAncestry(a, generations), await api.getAncestry(b, generations)];
  const toMap = (list: typeof ancA) => {
    const byId = new Map<string, number[]>();
    const byNumber = new Map<number, PersonSummary>();
    for (const { ahnentafel, person } of list) {
      byId.set(person.id, [...(byId.get(person.id) ?? []), ahnentafel]);
      byNumber.set(ahnentafel, person);
    }
    return { byId, byNumber };
  };
  const ma = toMap(ancA);
  const mb = toMap(ancB);
  const personA = ma.byNumber.get(1) ?? { id: a, name: a, gender: "Unknown" as const };
  const personB = mb.byNumber.get(1) ?? { id: b, name: b, gender: "Unknown" as const };

  let best: { ga: number; gb: number; na: number; nb: number; person: PersonSummary }[] = [];
  for (const [pid, numsA] of ma.byId) {
    const numsB = mb.byId.get(pid);
    if (!numsB) continue;
    for (const na of numsA) {
      for (const nb of numsB) {
        const candidate = { ga: generationOf(na), gb: generationOf(nb), na, nb, person: ma.byNumber.get(na)! };
        const total = candidate.ga + candidate.gb;
        const bestTotal = best.length ? best[0].ga + best[0].gb : Infinity;
        if (total < bestTotal) best = [candidate];
        else if (total === bestTotal && !best.some((x) => x.person.id === pid)) best.push(candidate);
      }
    }
  }

  if (best.length === 0) return { found: false, personA, personB, searchedGenerations: generations };

  const top = best[0];
  const path = (map: typeof ma, n: number) => {
    const out: PersonSummary[] = [];
    // Do próprio (1) até o ancestral comum (n), seguindo a numeração Ahnentafel.
    for (let k = n; k >= 1; k = Math.floor(k / 2)) out.unshift(map.byNumber.get(k)!);
    return out.filter(Boolean);
  };
  // Meio-parentesco: o cônjuge do ancestral comum é conhecido nos dois lados, mas é outra pessoa.
  const partnerA = ma.byNumber.get(top.na ^ 1);
  const partnerB = mb.byNumber.get(top.nb ^ 1);
  const half = top.ga > 0 && top.gb > 0 && Boolean(partnerA && partnerB && partnerA.id !== partnerB.id);
  const label = relationshipLabel(top.ga, top.gb, personB.gender, half);

  return {
    found: true,
    personA,
    personB,
    label: label.pt,
    labelEn: label.en,
    commonAncestors: best.map((x) => x.person),
    generationsFromA: top.ga,
    generationsFromB: top.gb,
    pathFromA: path(ma, top.na),
    pathFromB: path(mb, top.nb),
    searchedGenerations: generations,
  };
}

const ORDINAL_EN = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const TIMES_EN = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/**
 * Nome do parentesco de B em relação a A, dado o número de gerações de cada um até o ancestral comum.
 * ga = gerações de A até o ancestral comum; gb = gerações de B até ele.
 */
export function relationshipLabel(ga: number, gb: number, genderB: PersonSummary["gender"], half = false): { pt: string; en: string } {
  const f = genderB === "Female";
  const g = (m: string, fe: string) => (f ? fe : m);
  const halfPt = half ? " (meio-sangue)" : "";

  if (ga === 0 && gb === 0) return { pt: "a mesma pessoa", en: "same person" };

  if (ga === 0) {
    // B é descendente de A
    const names = [g("filho", "filha"), g("neto", "neta"), g("bisneto", "bisneta"), g("trineto", "trineta"), g("tetraneto", "tetraneta"), g("pentaneto", "pentaneta")];
    const pt = gb <= names.length ? names[gb - 1] : `descendente de ${gb}ª geração`;
    const en = gb === 1 ? "child" : gb === 2 ? "grandchild" : `${"great-".repeat(gb - 2)}grandchild`;
    return { pt, en };
  }

  if (gb === 0) {
    // B é ascendente de A
    const names = [g("pai", "mãe"), g("avô", "avó"), g("bisavô", "bisavó"), g("trisavô", "trisavó"), g("tetravô", "tetravó"), g("pentavô", "pentavó"), g("hexavô", "hexavó")];
    const pt = ga <= names.length ? names[ga - 1] : `ascendente de ${ga}ª geração`;
    const en = ga === 1 ? "parent" : ga === 2 ? "grandparent" : `${"great-".repeat(ga - 2)}grandparent`;
    return { pt, en };
  }

  if (ga === 1 && gb === 1) {
    return { pt: half ? g("meio-irmão", "meia-irmã") : g("irmão", "irmã"), en: half ? "half-sibling" : "sibling" };
  }

  if (ga === 1) {
    // B descende de um irmão de A
    const suffix = ["", g("-neto", "-neta"), g("-bisneto", "-bisneta"), g("-trineto", "-trineta")];
    const pt = `${g("sobrinho", "sobrinha")}${suffix[gb - 2] ?? ` (${gb - 1} gerações)`}${halfPt}`;
    const en = gb === 2 ? "nephew/niece" : `${"great-".repeat(gb - 3)}grand-nephew/niece`;
    return { pt, en };
  }

  if (gb === 1) {
    // B é irmão de um ascendente de A
    const suffix = ["", g("-avô", "-avó"), g("-bisavô", "-bisavó"), g("-trisavô", "-trisavó")];
    const pt = `${g("tio", "tia")}${suffix[ga - 2] ?? ` (${ga - 1} gerações)`}${halfPt}`;
    const en = ga === 2 ? "uncle/aunt" : `${"great-".repeat(ga - 3)}grand-uncle/aunt`;
    return { pt, en };
  }

  const degree = Math.min(ga, gb) - 1;
  const removed = Math.abs(ga - gb);
  const base = degree === 1 ? g("primo-irmão", "prima-irmã") : `${g("primo", "prima")} de ${degree}º grau`;
  const pt = `${base}${removed ? ` (${removed} geração${removed > 1 ? "ões" : ""} de diferença)` : ""}${halfPt}`;
  const en = `${half ? "half " : ""}${ORDINAL_EN(degree)} cousin${removed ? ` ${TIMES_EN(removed)} removed` : ""}`;
  return { pt, en };
}
