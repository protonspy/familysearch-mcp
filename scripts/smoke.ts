// Teste de integração contra o FamilySearch real.
// Uso: FAMILYSEARCH_TOKEN_FILE=~/.familysearch-token npx tsx scripts/smoke.ts [PERSON_ID]
import { FamilySearchApi } from "../src/api.js";
import { FamilySearchClient } from "../src/client.js";
import { exportTree } from "../src/export.js";
import { renderImage } from "../src/imaging.js";
import { FamilyTree, TreeBuilder, findRelationship } from "../src/tree.js";

const pid = process.argv[2] ?? "KNDX-MKG"; // George Washington, perfil público e bem documentado
// Óbito de 1945 no Registro Civil da Paraíba: coleção com imagens abertas e região do assento marcada.
const docId = process.env.SMOKE_DOCUMENT_ID ?? "QLZ1-89HC";
const api = new FamilySearchApi(new FamilySearchClient());

const checks: [string, () => Promise<unknown>][] = [
  ["whoami", () => api.currentUser().then((u) => ({ treePersonId: u?.treePersonId }))],
  ["person", () => api.getPerson(pid).then((p) => p && { name: p.name, gender: p.gender, birth: p.birth, facts: p.facts.length })],
  ["family", () => api.getFamily(pid).then((f) => ({ parents: f.parents.length, families: f.families.map((x) => [x.spouse?.name, x.children.length]) }))],
  ["ancestry(4)", () => api.getAncestry(pid, 4).then((l) => ({ count: l.length, last: l.at(-1)?.ahnentafel }))],
  ["descendancy(2)", () => api.getDescendancy(pid, 2).then((l) => ({ count: l.length, sample: l.slice(0, 4).map((x) => x.number) }))],
  ["sources", () => api.getPersonSources(pid).then((l) => ({ count: l.length, first: l[0]?.title }))],
  ["memories", () => api.getPersonMemories(pid).then((l) => ({ count: l.length }))],
  ["notes", () => api.getPersonNotes(pid).then((l) => ({ count: l.length }))],
  ["changes", () => api.getPersonChanges(pid, 3).then((c) => ({ total: c.total, first: c.changes[0]?.title }))],
  ["record hints", () => api.getPersonMatches(pid, "records", 5).then((r) => ({ total: r.total }))],
  ["duplicates", () => api.getPersonMatches(pid, "tree", 5).then((r) => ({ total: r.total }))],
  [
    "search tree",
    () =>
      api.searchTree({ givenName: "George", surname: "Washington", birthLikeDate: "1732" }, 3).then((r) => ({
        total: r.total,
        hits: r.hits.map((h) => [h.id, h.person.name, h.person.lifespan, h.relatives?.length]),
      })),
  ],
  [
    "search records",
    () =>
      api.searchRecords({ givenName: "José", surname: "Andrade", birthLikePlace: "Brasil", birthLikeDate: "1900-1920" }, 3).then((r) => ({
        total: r.total,
        hits: r.hits.map((h) => [h.id, h.person.name, h.person.gender, h.collection, h.relatives?.map((x) => x.relation)]),
        facetGroups: r.facets?.map((f) => f.name),
      })),
  ],
  [
    "record",
    async () => {
      const first = (await api.searchRecords({ givenName: "José", surname: "Andrade", birthLikeDate: "1910" }, 1)).hits[0];
      const rec = first && (await api.getRecord(first.id));
      return rec && { id: rec.id, principal: rec.principal?.name, persons: rec.persons.length, source: rec.source[0]?.title, attached: rec.attachedTreePersons.length };
    },
  ],
  ["places", () => api.searchPlaces("Lisboa", 2)],
  [
    "relationship",
    () =>
      // Augustine Washington (pai) x George Washington
      findRelationship(api, pid, "KNDX-MFX", 4).then((r) => ({ label: r.label, en: r.labelEn, common: r.commonAncestors?.map((p) => p.name) })),
  ],
  [
    "build tree (10 asc + 2 desc)",
    async () => {
      const tree = new FamilyTree("smoke", pid);
      await new TreeBuilder(api).build(tree, { ancestorGenerations: 10, descendantGenerations: 2, maxPersons: 600 });
      const ged = exportTree(tree, "gedcom");
      return { ...tree.stats(), gedcomLines: ged.split("\n").length };
    },
  ],
  [
    "document info",
    async () => {
      const doc = await api.locateDocument(docId);
      const info = await api.getImageInfo(doc.imageId);
      const index = await api.getImageIndex(doc.imageId, 3);
      return { imageId: doc.imageId, page: `${info.imageNumber}/${info.totalImages}`, viewable: info.viewable, folder: info.folderPath, indexed: index.total };
    },
  ],
  [
    "document image",
    async () => {
      const doc = await api.locateDocument(docId);
      const { data, source } = await api.getImageBytes(doc.imageId);
      const image = await renderImage(data, { maxSize: 1000, region: doc.region, grid: true });
      return { from: source, size: `${image.sourceWidth}x${image.sourceHeight}`, output: `${image.width}x${image.height}`, bytes: image.data.length };
    },
  ],
];

let failed = 0;
for (const [name, run] of checks) {
  const started = Date.now();
  try {
    const result = await run();
    console.log(`✔ ${name} (${Date.now() - started}ms)`, JSON.stringify(result));
  } catch (err) {
    failed++;
    console.log(`✘ ${name}:`, err instanceof Error ? err.message : err);
  }
}
process.exit(failed ? 1 : 0);
