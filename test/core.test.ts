import assert from "node:assert/strict";
import { test } from "node:test";
import { type FamilySearchApi, compareDescendancy, parseYearRange, toQueryString } from "../src/api.js";
import { gedcomDate, toGedcom, toText } from "../src/export.js";
import type { PersonSummary } from "../src/gedcomx.js";
import { FamilyTree, TreeBuilder, findRelationship, relationshipLabel } from "../src/tree.js";

const person = (id: string, gender: PersonSummary["gender"] = "Unknown"): PersonSummary => ({ id, name: `Pessoa ${id}`, gender });

test("toQueryString monta datas em intervalo, exatidão e filtros extras", () => {
  const qs = new URLSearchParams(
    toQueryString({ givenName: "José", surname: "Andrade", birthLikeDate: "1900-1920", exactNames: true, filters: "f.collectionId=3479702" }),
  );
  assert.equal(qs.get("q.givenName"), "José");
  assert.equal(qs.get("q.surname.exact"), "on");
  assert.equal(qs.get("q.birthLikeDate.from"), "1900");
  assert.equal(qs.get("q.birthLikeDate.to"), "1920");
  assert.equal(qs.get("f.collectionId"), "3479702");
  assert.throws(() => toQueryString({}));
  assert.deepEqual(parseYearRange("1890"), { from: "1890", to: "1890" });
});

test("compareDescendancy ordena pessoa, cônjuges e filhos", () => {
  const sorted = ["1.1", "1-S2.1", "1-S1", "1", "1.2", "1-S2", "1.10", "1.1-S1"].sort(compareDescendancy);
  assert.deepEqual(sorted, ["1", "1-S1", "1-S2", "1-S2.1", "1.1", "1.1-S1", "1.2", "1.10"]);
});

test("relationshipLabel nomeia graus de parentesco", () => {
  assert.equal(relationshipLabel(0, 2, "Female").pt, "neta");
  assert.equal(relationshipLabel(3, 0, "Male").pt, "bisavô");
  assert.equal(relationshipLabel(1, 1, "Female").pt, "irmã");
  assert.equal(relationshipLabel(2, 1, "Male").pt, "tio");
  assert.equal(relationshipLabel(1, 2, "Female").pt, "sobrinha");
  assert.equal(relationshipLabel(2, 2, "Male").pt, "primo-irmão");
  assert.equal(relationshipLabel(3, 3, "Male").en, "2nd cousin");
  assert.equal(relationshipLabel(2, 3, "Male").en, "1st cousin once removed");
});

test("gedcomDate converte datas formais do GEDCOM X", () => {
  assert.equal(gedcomDate({ formal: "+1918-12-03" }), "3 DEC 1918");
  assert.equal(gedcomDate({ formal: "A+1850" }), "ABT 1850");
  assert.equal(gedcomDate({ formal: "+1880/+1890" }), "BET 1880 AND 1890");
  assert.equal(gedcomDate({ date: "cerca de 1800" }), "cerca de 1800");
});

/** API falsa com descendência na numeração d'Aboville do FamilySearch (dois casamentos). */
function fakeApi(): FamilySearchApi {
  return {
    getPerson: async (pid: string) => person(pid),
    getDescendancy: async (pid: string) =>
      pid === "A"
        ? [
            { number: "1", person: person("A", "Male") },
            { number: "1-S1", person: person("W1", "Female") },
            { number: "1.1", person: person("C1") },
            { number: "1-S2", person: person("W2", "Female") },
            { number: "1-S2.1", person: person("C2") },
          ]
        : [],
  } as unknown as FamilySearchApi;
}

test("TreeBuilder encadeia blocos de ascendência renumerando em Ahnentafel global", async () => {
  // Linha paterna de 10 gerações: P0 ← P1 ← ... ← P10, mães em M1..M10. Exige 2 chamadas (8 + 2 gerações).
  const calls: string[] = [];
  const chain = (start: number, generations: number) => {
    const out = [{ ahnentafel: 1, person: person(`P${start}`, "Male") }];
    for (let g = 1; g <= generations && start + g <= 10; g++) {
      out.push({ ahnentafel: 2 ** g, person: person(`P${start + g}`, "Male") });
      if (g === 1) out.push({ ahnentafel: 3, person: person(`M${start + 1}`, "Female") });
    }
    return out;
  };
  const api = {
    getPerson: async (pid: string) => person(pid, "Male"),
    getAncestry: async (pid: string, g: number) => {
      calls.push(`${pid}:${g}`);
      return chain(Number(pid.slice(1)), g);
    },
  } as unknown as FamilySearchApi;

  const tree = new FamilyTree("t", "P0");
  await new TreeBuilder(api).build(tree, { ancestorGenerations: 10, descendantGenerations: 0, maxPersons: 100 });
  assert.deepEqual(calls, ["P0:8", "P8:2"]);
  assert.deepEqual(tree.ahnentafel.get("P8"), [256]);
  assert.deepEqual(tree.ahnentafel.get("P10"), [1024]);
  assert.deepEqual(tree.ahnentafel.get("M9"), [513]);
  assert.ok(tree.families.get("M1+P1")?.children.has("P0"));
  assert.ok(tree.families.get("M9+P9")?.children.has("P8"));
  assert.equal(tree.stats().ancestorGenerations, 10);
  assert.match(toText(tree), /1024\. Pessoa P10/);
});

test("TreeBuilder liga filhos ao cônjuge correto pela numeração d'Aboville", async () => {
  const tree = new FamilyTree("t", "A");
  await new TreeBuilder(fakeApi()).build(tree, { ancestorGenerations: 0, descendantGenerations: 2, maxPersons: 100 });
  assert.deepEqual([...tree.families.get("A+W1")!.children], ["C1"]);
  assert.deepEqual([...tree.families.get("A+W2")!.children], ["C2"]);
  const ged = toGedcom(tree);
  assert.match(ged, /0 @F\d+@ FAM\n1 HUSB @I\d+@\n1 WIFE @I\d+@\n1 CHIL/);
  assert.match(ged, /1 _FSFTID C2/);
  assert.ok(ged.endsWith("0 TRLR\n"));
});

test("findRelationship encontra primos pelo ancestral comum", async () => {
  // A e B são filhos de irmãos (F e U, ambos filhos de G1+G2) → primos-irmãos.
  const anc: Record<string, { ahnentafel: number; person: PersonSummary }[]> = {
    A: [1, 2, 4, 5].map((n, i) => ({ ahnentafel: n, person: person(["A", "F", "G1", "G2"][i], n === 5 ? "Female" : "Male") })),
    B: [1, 2, 4, 5].map((n, i) => ({ ahnentafel: n, person: person(["B", "U", "G1", "G2"][i], n === 1 ? "Female" : "Male") })),
  };
  const api = { getAncestry: async (pid: string) => anc[pid] } as unknown as FamilySearchApi;
  const r = await findRelationship(api, "A", "B", 8);
  assert.equal(r.found, true);
  assert.equal(r.label, "prima-irmã");
  assert.deepEqual(r.commonAncestors?.map((p) => p.id).sort(), ["G1", "G2"]);
  assert.deepEqual(r.pathFromA?.map((p) => p.id), ["A", "F", "G1"]);
});
