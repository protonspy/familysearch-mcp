// Teste de integração contra o FamilySearch real.
// Uso: FAMILYSEARCH_TOKEN_FILE=~/.familysearch-token npx tsx scripts/smoke.ts [PERSON_ID]
// SMOKE_SAVE_DIR=<pasta> salva a imagem com as linhas marcadas para conferência visual.
import { writeFile } from "node:fs/promises";
import { FamilySearchApi } from "../src/api.js";
import { FamilySearchClient } from "../src/client.js";
import { exportTree } from "../src/export.js";
import { renderImage } from "../src/imaging.js";
import { marksInRegion } from "../src/transcript.js";
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
  [
    "browse images (pastas da paróquia do documento)",
    async () => {
      const doc = await api.locateDocument(docId);
      const info = await api.getImageInfo(doc.imageId);
      const parent = info.folders?.at(-2);
      if (!info.collectionId || !parent?.waypointId) throw new Error("documento sem waypoints");
      const folder = await api.browseImages(info.collectionId, parent.waypointId, 0, 3);
      const book = folder.folders?.[0];
      const books = book?.waypointId ? await api.browseImages(info.collectionId, book.waypointId, 0, 2) : undefined;
      return { folder: folder.title, subfolders: folder.folders?.length, firstBook: book?.title, images: books?.totalImages, first: books?.images?.[0] };
    },
  ],
  [
    "full text",
    () =>
      api.searchFullText({ text: "Anselmo Cecilia", place: "Pilões, Paraíba, Brasil", collectionId: "2177286", count: 3 }).then((r) => ({
        total: r.total,
        hits: r.hits?.map((h) => [h.imageId, h.date, h.type, h.snippets?.[0]?.slice(0, 80)]),
      })),
  ],
  [
    "catalog",
    async () => {
      const search = await api.searchCatalog({ place: "Brasil, Paraíba, Bananeiras", placeExact: true });
      const item = await api.getCatalogItem("koha:248067");
      return { total: search.total, items: search.items?.map((i) => i.id), films: item.films?.length, sample: item.films?.find((f) => /Casamentos 1889/.test(f.contents ?? "")) };
    },
  ],
  ["film", () => api.getFilm("4016084", 0, 2).then((f) => ({ total: f.totalImages, first: f.images, catalogs: f.catalogs?.map((c) => c.id) }))],
  [
    "image text",
    // Matrimônios de Bananeiras, fev/1906 (livro sem índice).
    () => api.getImageText("3:1:33SQ-GPQ3-DGM", true).then((t) => ({ source: t.source, lines: t.lines?.length, start: t.text.slice(0, 60) })),
  ],
  [
    "marked lines",
    // Casamento de 23/05/1905 (assento nº 94): marcas de linha sobre o recorte realçado.
    async () => {
      const region = { x: 0.04, y: 0.628, width: 0.41, height: 0.248 };
      const { page } = await api.texts.get("33S7-9PQ3-DP6");
      const marks = marksInRegion(page!, region);
      const { data } = await api.getImageBytes("33S7-9PQ3-DP6");
      const image = await renderImage(data, { region, maxSize: 1568, enhance: true, marks });
      if (process.env.SMOKE_SAVE_DIR) await writeFile(`${process.env.SMOKE_SAVE_DIR}/marked-lines.jpg`, image.data);
      return { margin: marks.filter((m) => m.kind === "margin").map((m) => m.text), body: marks.filter((m) => m.kind === "body").length, bytes: image.data.length };
    },
  ],
  [
    "book text search",
    () =>
      api
        .searchBookText({ collectionId: "2177286", waypointId: "9VR1-6YS:370202701,370144202,370997701", fromImage: 124, toImage: 128, terms: ["Manoel", "Paulino"] })
        .then((r) => ({ book: r.book, searched: r.searched, downloaded: r.downloaded, hits: r.totalHits, first: r.hits?.[0] && { image: r.hits[0].imageNumber, found: r.hits[0].matches.map((m) => m.found) } })),
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
