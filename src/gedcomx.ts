// Tipos parciais do GEDCOM X (formato JSON da API do FamilySearch) e conversão para resumos enxutos.

export interface GxResourceRef {
  resource?: string;
  resourceId?: string;
}

export interface GxFact {
  type?: string;
  value?: string;
  date?: { original?: string; formal?: string; normalized?: { value: string }[] };
  place?: { original?: string; normalized?: { value: string }[]; description?: string };
  primary?: boolean;
}

export interface GxNamePart {
  type?: string;
  value?: string;
}

export interface GxName {
  type?: string;
  preferred?: boolean;
  nameForms?: { fullText?: string; parts?: GxNamePart[]; lang?: string }[];
}

export interface GxPersonDisplay {
  name?: string;
  gender?: string;
  lifespan?: string;
  birthDate?: string;
  birthPlace?: string;
  deathDate?: string;
  deathPlace?: string;
  marriageDate?: string;
  marriagePlace?: string;
  ascendancyNumber?: string;
  descendancyNumber?: string;
  familiesAsParent?: { parent1?: GxResourceRef; parent2?: GxResourceRef; children?: GxResourceRef[] }[];
  familiesAsChild?: { parent1?: GxResourceRef; parent2?: GxResourceRef; children?: GxResourceRef[] }[];
}

export interface GxPerson {
  id: string;
  living?: boolean;
  principal?: boolean;
  gender?: { type?: string };
  names?: GxName[];
  facts?: GxFact[];
  display?: GxPersonDisplay & { role?: string };
  identifiers?: Record<string, string[]>;
  links?: Record<string, { href?: string }>;
  sources?: { descriptionId?: string; description?: string }[];
}

export interface GxRelationship {
  id?: string;
  type?: string;
  person1?: GxResourceRef;
  person2?: GxResourceRef;
  facts?: GxFact[];
}

export interface GxChildAndParents {
  id?: string;
  parent1?: GxResourceRef;
  parent2?: GxResourceRef;
  child?: GxResourceRef;
  /** Formato antigo da API. */
  father?: GxResourceRef;
  mother?: GxResourceRef;
}

export interface GxSourceDescription {
  id?: string;
  about?: string;
  titles?: { value?: string }[];
  citations?: { value?: string }[];
  notes?: { subject?: string; text?: string }[];
  resourceType?: string;
  mediaType?: string;
  descriptions?: { value?: string }[];
  /** Referências a outras descrições; em registros, aponta para a imagem com a região do assento (`RectangleRegion`). */
  sources?: { description?: string; descriptionId?: string; qualifiers?: { name?: string; value?: string }[] }[];
  componentOf?: { description?: string };
}

export interface GxLink {
  href?: string;
  /** Em imagens: posição (1 = primeira) e total de imagens da pasta. */
  offset?: number;
  results?: number;
}

export interface Gedcomx {
  description?: string;
  persons?: GxPerson[];
  relationships?: GxRelationship[];
  childAndParentsRelationships?: GxChildAndParents[];
  sourceDescriptions?: GxSourceDescription[];
  places?: any[];
  links?: Record<string, GxLink>;
}

export interface AtomEntry {
  id?: string;
  title?: string;
  score?: number;
  confidence?: number;
  content?: { gedcomx?: Gedcomx };
  links?: Record<string, { href?: string }>;
}

export interface SearchFacet {
  displayName?: string;
  count?: number;
  /** Parâmetros prontos para refinar a busca (ex.: `f.collectionId=...`). */
  params?: string;
  facets?: SearchFacet[];
}

export interface AtomFeed {
  results?: number;
  index?: number;
  entries?: AtomEntry[];
  links?: Record<string, { href?: string }>;
  facets?: SearchFacet[];
}

export interface PersonSummary {
  id: string;
  name: string;
  givenName?: string;
  surname?: string;
  gender: "Male" | "Female" | "Unknown";
  lifespan?: string;
  living?: boolean;
  birth?: EventSummary;
  christening?: EventSummary;
  death?: EventSummary;
  burial?: EventSummary;
  url?: string;
}

export interface EventSummary {
  date?: string;
  /** Data no formato GEDCOM X formal (ex.: `+1918-12-03`), usada na exportação GEDCOM. */
  formal?: string;
  place?: string;
}

const lastSegment = (uri?: string) => (uri ? uri.slice(uri.lastIndexOf("/") + 1) : undefined);

/** Id de uma referência GEDCOM X (resourceId ou fim da URL/`#id`). */
export function refId(ref?: GxResourceRef): string | undefined {
  if (!ref) return undefined;
  if (ref.resourceId) return ref.resourceId;
  const r = ref.resource;
  if (!r) return undefined;
  return r.startsWith("#") ? r.slice(1) : lastSegment(r.replace(/\?.*$/, ""));
}

export function factType(fact: GxFact) {
  return lastSegment(fact.type) ?? "Unknown";
}

function eventOf(facts: GxFact[] | undefined, ...types: string[]): EventSummary | undefined {
  const matching = (facts ?? []).filter((f) => types.includes(factType(f)));
  const fact = matching.find((f) => f.primary) ?? matching[0];
  if (!fact) return undefined;
  const date = fact.date?.normalized?.[0]?.value ?? fact.date?.original;
  const place = fact.place?.normalized?.[0]?.value ?? fact.place?.original;
  return date || place ? clean({ date, formal: fact.date?.formal, place }) : undefined;
}

/** Usa os textos de `display` (já localizados) e completa com a data formal dos fatos, se houver. */
function displayEvent(date: string | undefined, place: string | undefined, fromFacts: EventSummary | undefined) {
  if (!date && !place) return fromFacts;
  return clean({ date: date ?? fromFacts?.date, formal: fromFacts?.formal, place: place ?? fromFacts?.place });
}

export function preferredName(person: GxPerson) {
  const name = person.names?.find((n) => n.preferred) ?? person.names?.[0];
  const form = name?.nameForms?.[0];
  const part = (type: string) => form?.parts?.find((p) => lastSegment(p.type) === type)?.value;
  return { fullText: form?.fullText, given: part("Given"), surname: part("Surname") };
}

function normalizeGender(type?: string, display?: string): PersonSummary["gender"] {
  // `gender.type` é estável; `display.gender` vem traduzido ("Masculino", "Sexo feminino"...).
  const g = lastSegment(type)?.toLowerCase();
  if (g === "male") return "Male";
  if (g === "female") return "Female";
  const d = display?.toLowerCase() ?? "";
  if (/fem|female|mulher/.test(d)) return "Female";
  if (/masc|male|homem/.test(d)) return "Male";
  return "Unknown";
}

export function summarizePerson(person: GxPerson, webUrl = "https://www.familysearch.org"): PersonSummary {
  const d = person.display ?? {};
  const name = preferredName(person);
  const birth = displayEvent(d.birthDate, d.birthPlace, eventOf(person.facts, "Birth", "BirthRegistration"));
  const death = displayEvent(d.deathDate, d.deathPlace, eventOf(person.facts, "Death", "DeathRegistration"));
  return clean({
    id: person.id,
    name: d.name ?? name.fullText ?? ([name.given, name.surname].filter(Boolean).join(" ") || "(sem nome)"),
    givenName: name.given,
    surname: name.surname,
    gender: normalizeGender(person.gender?.type, d.gender),
    lifespan: d.lifespan,
    living: person.living,
    birth,
    christening: eventOf(person.facts, "Christening", "Baptism"),
    death,
    burial: eventOf(person.facts, "Burial"),
    url: isTreePersonId(person.id) ? `${webUrl}/tree/person/details/${person.id}` : undefined,
  });
}

/** Todos os fatos de uma pessoa em formato legível. */
export function summarizeFacts(facts: GxFact[] | undefined) {
  return (facts ?? []).map((f) =>
    clean({
      type: factType(f),
      value: f.value,
      date: f.date?.normalized?.[0]?.value ?? f.date?.original,
      place: f.place?.normalized?.[0]?.value ?? f.place?.original,
    }),
  );
}

export function allNames(person: GxPerson) {
  return (person.names ?? []).map((n) =>
    clean({ type: lastSegment(n.type), preferred: n.preferred, fullText: n.nameForms?.[0]?.fullText }),
  );
}

export function isTreePersonId(id: string) {
  return /^[A-Z0-9]{4}-[A-Z0-9]{2,4}$/.test(id);
}

/** Id persistente (ark) de uma persona de registro, quando houver. */
export function personaArk(person: GxPerson) {
  const ids = person.identifiers?.["http://gedcomx.org/Persistent"];
  return (Array.isArray(ids) ? ids[0] : ids) ?? person.links?.persona?.href;
}

/** Remove chaves undefined para enxugar o JSON devolvido ao modelo. */
export function clean<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

export interface CoupleSummary {
  id?: string;
  person1?: string;
  person2?: string;
  marriage?: EventSummary;
}

export function summarizeCouple(rel: GxRelationship): CoupleSummary {
  return clean({ id: rel.id, person1: refId(rel.person1), person2: refId(rel.person2), marriage: eventOf(rel.facts, "Marriage") });
}

export function parentsOf(cap: GxChildAndParents) {
  return { parent1: refId(cap.parent1 ?? cap.father), parent2: refId(cap.parent2 ?? cap.mother), child: refId(cap.child) };
}
