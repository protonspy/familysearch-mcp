import type { EventSummary, PersonSummary } from "./gedcomx.js";
import { type FamilyTree, generationOf } from "./tree.js";

export type ExportFormat = "gedcom" | "mermaid" | "text" | "json";

export const EXTENSIONS: Record<ExportFormat, string> = { gedcom: "ged", mermaid: "mmd", text: "txt", json: "json" };

export function exportTree(tree: FamilyTree, format: ExportFormat) {
  switch (format) {
    case "gedcom":
      return toGedcom(tree);
    case "mermaid":
      return toMermaid(tree);
    case "text":
      return toText(tree);
    case "json":
      return JSON.stringify(toJson(tree), null, 2);
  }
}

export function toJson(tree: FamilyTree) {
  return {
    ...tree.stats(),
    createdAt: tree.createdAt.toISOString(),
    persons: [...tree.persons.values()].map((p) => ({ ...p, ahnentafel: tree.ahnentafel.get(p.id) })),
    families: [...tree.families.values()].map((f) => ({ ...f, children: [...f.children] })),
  };
}

// ---------------------------------------------------------------------------
// GEDCOM 5.5.1
// ---------------------------------------------------------------------------

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Converte a data formal do GEDCOM X (`+1890-03-12`, `A+1890`, `+1890/+1900`) para GEDCOM 5.5.1. */
export function gedcomDate(event?: EventSummary) {
  const formal = event?.formal;
  if (!formal) return event?.date;
  const one = (s: string) => {
    const m = s.match(/^[+-]?(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
    if (!m) return undefined;
    return [m[3] ? String(Number(m[3])) : undefined, m[2] ? MONTHS[Number(m[2]) - 1] : undefined, m[1]].filter(Boolean).join(" ");
  };
  const approx = formal.startsWith("A");
  const body = formal.replace(/^A/, "");
  if (body.includes("/")) {
    const [from, to] = body.split("/");
    if (from && to) return `BET ${one(from)} AND ${one(to)}`;
    if (from) return `AFT ${one(from)}`;
    if (to) return `BEF ${one(to)}`;
  }
  const date = one(body);
  return date ? `${approx ? "ABT " : ""}${date}` : event?.date;
}

function gedcomName(p: PersonSummary) {
  if (p.givenName || p.surname) return `${p.givenName ?? ""} /${p.surname ?? ""}/`.trim();
  const parts = p.name.trim().split(/\s+/);
  if (parts.length < 2) return p.name;
  const surname = parts.pop();
  return `${parts.join(" ")} /${surname}/`;
}

/** Quebra linhas longas com CONC (limite de 255 caracteres por linha do GEDCOM). */
function line(level: number, tag: string, value?: string) {
  if (value === undefined || value === "") return [`${level} ${tag}`];
  const clean = value.replace(/[\r\n]+/g, " ");
  const out = [`${level} ${tag} ${clean.slice(0, 200)}`];
  for (let i = 200; i < clean.length; i += 200) out.push(`${level + 1} CONC ${clean.slice(i, i + 200)}`);
  return out;
}

function eventLines(tag: string, event?: EventSummary) {
  if (!event) return [];
  return [...line(1, tag), ...(event.date || event.formal ? line(2, "DATE", gedcomDate(event)) : []), ...(event.place ? line(2, "PLAC", event.place) : [])];
}

export function toGedcom(tree: FamilyTree) {
  const indi = new Map([...tree.persons.keys()].map((id, i) => [id, `@I${i + 1}@`]));
  const fam = new Map([...tree.families.keys()].map((id, i) => [id, `@F${i + 1}@`]));
  const out: string[] = [
    "0 HEAD",
    "1 SOUR FAMILYSEARCH_MCP",
    "2 NAME familysearch-mcp",
    "2 VERS 0.1.0",
    `1 DATE ${gedcomDate({ formal: `+${new Date().toISOString().slice(0, 10)}` })}`,
    "1 GEDC",
    "2 VERS 5.5.1",
    "2 FORM LINEAGE-LINKED",
    "1 CHAR UTF-8",
  ];

  for (const [id, p] of tree.persons) {
    out.push(`0 ${indi.get(id)} INDI`, ...line(1, "NAME", gedcomName(p)));
    if (p.givenName) out.push(...line(2, "GIVN", p.givenName));
    if (p.surname) out.push(...line(2, "SURN", p.surname));
    out.push(`1 SEX ${p.gender === "Male" ? "M" : p.gender === "Female" ? "F" : "U"}`);
    out.push(...eventLines("BIRT", p.birth), ...eventLines("CHR", p.christening), ...eventLines("DEAT", p.death), ...eventLines("BURI", p.burial));
    out.push(`1 _FSFTID ${id}`);
    if (p.url) out.push(...line(1, "WWW", p.url));
    for (const f of tree.parentsOf(id)) out.push(`1 FAMC ${fam.get(f.id)}`);
    for (const f of tree.familiesAsParent(id)) out.push(`1 FAMS ${fam.get(f.id)}`);
  }

  for (const [id, f] of tree.families) {
    out.push(`0 ${fam.get(id)} FAM`);
    const [a, b] = f.parents.map((pid) => tree.persons.get(pid));
    // GEDCOM 5.5.1 exige HUSB/WIFE; usa o sexo quando conhecido e a ordem como desempate.
    const husband = [a, b].find((p) => p?.gender === "Male") ?? (a?.gender !== "Female" ? a : b);
    const wife = [a, b].find((p) => p && p !== husband);
    if (husband) out.push(`1 HUSB ${indi.get(husband.id)}`);
    if (wife) out.push(`1 WIFE ${indi.get(wife.id)}`);
    for (const child of f.children) if (indi.has(child)) out.push(`1 CHIL ${indi.get(child)}`);
    out.push(...eventLines("MARR", f.marriage));
  }

  out.push("0 TRLR");
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

export function toMermaid(tree: FamilyTree) {
  const node = (id: string) => `P_${id.replace(/[^A-Za-z0-9]/g, "_")}`;
  const esc = (s: string) => s.replace(/"/g, "'");
  const out = ["flowchart TD"];
  for (const [id, p] of tree.persons) {
    const sub = [p.lifespan, id].filter(Boolean).join(" · ");
    const cls = p.gender === "Male" ? "male" : p.gender === "Female" ? "female" : "unknown";
    out.push(`  ${node(id)}["${esc(p.name)}<br/><small>${esc(sub)}</small>"]:::${cls}`);
  }
  let i = 0;
  for (const f of tree.families.values()) {
    const fid = `F${++i}`;
    out.push(`  ${fid}(( ))`);
    for (const parent of f.parents) out.push(`  ${node(parent)} --- ${fid}`);
    for (const child of f.children) out.push(`  ${fid} --> ${node(child)}`);
  }
  out.push(
    "  classDef male fill:#dbeafe,stroke:#2563eb,color:#1e3a8a",
    "  classDef female fill:#fce7f3,stroke:#db2777,color:#831843",
    "  classDef unknown fill:#f3f4f6,stroke:#6b7280,color:#111827",
  );
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Texto (pedigree + descendência)
// ---------------------------------------------------------------------------

const describe = (p?: PersonSummary) => {
  if (!p) return "?";
  const life = p.lifespan ?? [p.birth?.date && `n. ${p.birth.date}`, p.death?.date && `f. ${p.death.date}`].filter(Boolean).join(", ");
  return `${p.name}${life ? ` (${life})` : ""} [${p.id}]`;
};

export function toText(tree: FamilyTree) {
  const root = tree.persons.get(tree.rootId);
  const out: string[] = [`Árvore de ${describe(root)} — ${tree.persons.size} pessoas, ${tree.families.size} famílias`, ""];

  const ancestors = [...tree.ahnentafel.entries()].flatMap(([id, nums]) => nums.map((n) => ({ n, id }))).sort((a, b) => a.n - b.n);
  if (ancestors.length > 1) {
    out.push("ASCENDÊNCIA (numeração Ahnentafel)");
    const seen = new Set<string>();
    const walk = (n: number, id: string, depth: number) => {
      const repeated = seen.has(id);
      seen.add(id);
      out.push(`${"    ".repeat(depth)}${n}. ${describe(tree.persons.get(id))}${repeated ? " ↺ (já listado)" : ""}`);
      if (repeated) return;
      for (const parentNumber of [2 * n, 2 * n + 1]) {
        const parent = ancestors.find((a) => a.n === parentNumber);
        if (parent) walk(parent.n, parent.id, depth + 1);
      }
    };
    walk(1, tree.rootId, 0);
    out.push("", `Gerações: ${Math.max(...ancestors.map((a) => generationOf(a.n))) + 1}`, "");
  }

  const hasDescendants = tree.familiesAsParent(tree.rootId).some((f) => f.children.size > 0);
  if (hasDescendants) {
    out.push("DESCENDÊNCIA");
    const visited = new Set<string>();
    const walk = (id: string, depth: number, label: string) => {
      out.push(`${"    ".repeat(depth)}${label} ${describe(tree.persons.get(id))}`);
      if (visited.has(id)) return;
      visited.add(id);
      tree.familiesAsParent(id).forEach((f) => {
        const spouse = f.parents.find((p) => p !== id);
        if (spouse) out.push(`${"    ".repeat(depth)}  ⚭ ${describe(tree.persons.get(spouse))}`);
        [...f.children].forEach((child, k) => walk(child, depth + 1, `${label}${k + 1}.`));
      });
    };
    walk(tree.rootId, 0, "1.");
  }
  return out.join("\n") + "\n";
}
