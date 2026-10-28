import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogQuery,
  fullTextQuery,
  imageFolders,
  normalizeDgs,
  parseWaypointUrl,
  snippetsAround,
  summarizeCatalogItem,
  summarizeCatalogSearch,
  summarizeFilm,
  summarizeFullText,
  summarizeWaypoint,
} from "../src/discovery.js";

const WP = "https://www.familysearch.org/platform/records/waypoints";

test("parseWaypointUrl extrai a pasta e a coleção", () => {
  assert.deepEqual(parseWaypointUrl(`${WP}/9VRP-2NG:370147101,370147102?cc=2177286`), {
    waypointId: "9VRP-2NG:370147101,370147102",
    collectionId: "2177286",
  });
  assert.deepEqual(parseWaypointUrl("/platform/records/collections/2177286/waypoints"), { collectionId: "2177286" });
  assert.deepEqual(parseWaypointUrl(undefined), {});
});

test("imageFolders devolve as pastas acima da imagem com o id de cada uma", () => {
  const data = {
    sourceDescriptions: [
      { id: "img", resourceType: "http://gedcomx.org/DigitalArtifact", about: "https://www.familysearch.org/ark:/61903/3:1:33SQ-GP9C-XTV", componentOf: { description: "#b" } },
      { id: "b", resourceType: "http://gedcomx.org/Collection", titles: [{ value: "Batismos 1900, Fev-1901, Fev" }], about: `${WP}/9VRP-L2D:1,2,3?cc=2177286`, componentOf: { description: "#p" } },
      { id: "p", resourceType: "http://gedcomx.org/Collection", titles: [{ value: "Sagrado Coração de Jesus" }], about: `${WP}/9VRP-2NG:1,2?cc=2177286`, componentOf: { description: "#t" } },
      { id: "t", resourceType: "http://gedcomx.org/Collection", titles: [{ value: "Pilões" }], about: `${WP}/9VRP-2NL:1?cc=2177286`, componentOf: { description: "#r" } },
      { id: "r", resourceType: "http://gedcomx.org/Collection", titles: [{ value: "Brasil, Paraíba, Registros da Igreja Católica" }], about: "https://www.familysearch.org/platform/records/collections/2177286/waypoints", componentOf: { description: "#c" } },
      { id: "c", resourceType: "http://gedcomx.org/Collection", titles: [{ value: "Brasil, Paraíba, Registros da Igreja Católica" }], about: "https://www.familysearch.org/platform/records/collections/2177286" },
    ],
  };
  const { collectionId, folders } = imageFolders(data);
  assert.equal(collectionId, "2177286");
  assert.deepEqual(
    folders.map((f) => [f.title, f.waypointId]),
    [
      ["Brasil, Paraíba, Registros da Igreja Católica", undefined],
      ["Pilões", "9VRP-2NL:1"],
      ["Sagrado Coração de Jesus", "9VRP-2NG:1,2"],
      ["Batismos 1900, Fev-1901, Fev", "9VRP-L2D:1,2,3"],
    ],
  );
});

test("summarizeWaypoint separa caminho, subpastas e imagens paginadas", () => {
  const parish = {
    description: "#src_1",
    sourceDescriptions: [
      { id: "src_1", resourceType: "http://gedcomx.org/Collection", titles: [{ value: "Sagrado Coração de Jesus" }], about: `${WP}/9VRP-2NG:1,2?cc=2177286`, componentOf: { description: "#src_2" } },
      { id: "src_2", resourceType: "http://gedcomx.org/Collection", titles: [{ value: "Pilões" }], about: `${WP}/9VRP-2NL:1?cc=2177286` },
      { id: "sd_5", resourceType: "http://gedcomx.org/Collection", titles: [{ value: "Matrimônios 1892, Jan-1903, Out" }], about: `${WP}/9VRP-RMH:1,2,9?cc=2177286`, componentOf: { description: "#src_1" } },
    ],
  };
  const folder = summarizeWaypoint(parish);
  assert.equal(folder.title, "Sagrado Coração de Jesus");
  assert.deepEqual(folder.path?.map((p) => p.title), ["Pilões", "Sagrado Coração de Jesus"]);
  assert.deepEqual(folder.folders, [{ title: "Matrimônios 1892, Jan-1903, Out", waypointId: "9VRP-RMH:1,2,9" }]);
  assert.equal(folder.images, undefined);

  const book = {
    description: "#b",
    sourceDescriptions: [
      { id: "b", resourceType: "http://gedcomx.org/Collection", titles: [{ value: "Matrimônios 1892" }], about: `${WP}/9VRP-RMH:1,2,9?cc=2177286` },
      ...["AAAA-BBB-CC1", "AAAA-BBB-CC2", "AAAA-BBB-CC3"].map((id) => ({
        id,
        resourceType: "http://gedcomx.org/DigitalArtifact",
        about: `https://www.familysearch.org/ark:/61903/3:1:${id}?cc=2177286`,
      })),
    ],
  };
  const page = summarizeWaypoint(book, 1, 1);
  assert.equal(page.totalImages, 3);
  assert.deepEqual(page.images, [{ number: 2, imageId: "AAAA-BBB-CC2" }]);
  assert.equal(page.nextOffset, 2);
});

test("fullTextQuery e catalogQuery montam os parâmetros do site", () => {
  const q = fullTextQuery({ text: " Anselmo Cecilia ", place: "Pilões, Paraíba, Brasil", years: "1890-1903", collectionId: "2177286" });
  assert.equal(q["q.text"], "Anselmo Cecilia");
  assert.equal(q["q.recordPlace"], "Pilões, Paraíba, Brasil");
  assert.equal(q["q.recordYear.from"], "1890");
  assert.equal(q["q.recordYear.to"], "1903");
  assert.equal(q["q.collectionId"], "2177286");
  assert.throws(() => fullTextQuery({ text: "  " }));

  const c = catalogQuery({ place: "Brasil, Paraíba, Bananeiras", placeExact: true });
  assert.equal(c["q.place"], "Brasil, Paraíba, Bananeiras");
  assert.equal(c["q.place.exact"], "on");
  assert.throws(() => catalogQuery({}));
});

test("snippetsAround junta ocorrências próximas e limita a quantidade", () => {
  const text = `${"x ".repeat(200)}filha de Anselmo José Antonio e de Cecilia Maria ${"y ".repeat(200)}Anselmo de novo`;
  const s = snippetsAround(text, ["Anselmo", "Cecilia"], 3, 40);
  assert.equal(s.length, 2);
  assert.match(s[0], /Anselmo José Antonio e de Cecilia/);
  assert.match(s[1], /Anselmo de novo$/);

  // Com limite, fica o trecho que reúne os dois nomes, mesmo que outro apareça antes na página.
  const page = `Cecilia sozinha ${"z ".repeat(200)}Anselmo e Cecilia juntos`;
  const best = snippetsAround(page, ["Anselmo", "Cecilia"], 1, 30);
  assert.equal(best.length, 1);
  assert.match(best[0], /Anselmo e Cecilia juntos$/);
});

test("summarizeFullText resume os acertos com trechos", () => {
  const r = summarizeFullText({
    results: 120,
    entries: [
      {
        id: "3:1:33SQ-GP9C-XTV",
        collectionId: "2177286",
        collectionTitle: "Brasil, Paraíba, Registros da Igreja Católica",
        content: { recordDate: "1900-1901", recordType: "Baptism", recordPlace: "Pilões, Paraíba, Brazil", highlightTexts: ["Anselmo", "Anselmo"], textDocument: "filha legítima de Anselmo José Antonio" },
      },
    ],
  });
  assert.equal(r.total, 120);
  assert.equal(r.hits?.[0].imageId, "33SQ-GP9C-XTV");
  assert.deepEqual(r.hits?.[0].matched, ["Anselmo"]);
  assert.equal(r.hits?.[0].snippets?.[0], "filha legítima de Anselmo José Antonio");
  assert.equal(r.hits?.[0].text, undefined);
});

test("summarizeCatalogSearch e summarizeCatalogItem leem o catálogo", () => {
  const search = summarizeCatalogSearch({
    totalHits: 1,
    searchHits: [
      {
        metadataHit: {
          metadata: {
            identifier: { value: "https://www.familysearch.org/service/search/catalog/item/koha:248067" },
            title: [{ value: "Registros paroquiais, 1836-1961" }],
            creator: ["Igreja Católica. Nossa Senhora do Livramento (Bananeiras)"],
            properties: [{ type: "org.familysearch.www.catalog.topic", value: "Birth, Marriage and Death" }],
            repositoryCalls: [{ title: "Online" }, { title: "FamilySearch Library" }, { title: "Online" }],
          },
        },
      },
    ],
  });
  assert.equal(search.items?.[0].id, "koha:248067");
  assert.equal(search.items?.[0].online, true);
  assert.deepEqual(search.items?.[0].availability, ["Online", "FamilySearch Library"]);

  const item = summarizeCatalogItem("koha:248067", {
    source: {
      title: "Registros paroquiais,",
      note: [{ text: "Microfilme de originais.", type: "x", seq: 1 }],
      film_note: [{ filmno: "1285561", digital_film_no: "4016084", text: "Casamentos   1889-1902", digital_film_rights: "", item_image_start_no: "" }],
    },
  });
  assert.equal(item.title, "Registros paroquiais,");
  assert.deepEqual(item.films, [{ contents: "Casamentos 1889-1902", filmNumber: "1285561", dgsNumber: "4016084" }]);
});

test("normalizeDgs e summarizeFilm", () => {
  assert.equal(normalizeDgs("4016084"), "004016084");
  assert.equal(normalizeDgs("DGS 004016084"), "004016084");
  assert.throws(() => normalizeDgs("abc"));
  const film = summarizeFilm(
    "004016084",
    {
      dgsNum: "004016084",
      images: ["https://www.familysearch.org/ark:/61903/3:1:3QS7-8923-R7YF/image.xml", "https://www.familysearch.org/ark:/61903/3:1:3QS7-8923-RW7J/image.xml"],
      catalogs: [{ path: "/search/catalog/info/koha:248067", data: { title: "Registros paroquiais," } }],
    },
    0,
    1,
  );
  assert.equal(film.totalImages, 2);
  assert.deepEqual(film.images, [{ number: 1, imageId: "3QS7-8923-R7YF" }]);
  assert.equal(film.nextOffset, 1);
  assert.deepEqual(film.catalogs, [{ id: "koha:248067", title: "Registros paroquiais," }]);
});
