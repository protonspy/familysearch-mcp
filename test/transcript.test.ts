import assert from "node:assert/strict";
import { test } from "node:test";
import { editDistance, foldWord, marksInRegion, pageText, parseTranscript, searchPage } from "../src/transcript.js";

/** Resposta do serviço de transcrição no formato do site: linhas com tokens e retângulos "x,y,w,h" em pixels. */
const line = (y: number, text: string, x = 100) => ({ rect: `${x},${y},800,40`, tokens: text.split(" ").map((t) => ({ text: t })) });
const response = (lines: ReturnType<typeof line>[]) => ({
  stuff: {
    pages: [{ pageWidth: 1000, pageHeight: 2000 }],
    regions: [
      { type: "PAGE_NUMBER", rect: "10,10,50,20", lines: [line(10, "110", 10)] },
      { type: "PARAGRAPH", rect: "100,100,800,1800", lines },
    ],
  },
});

test("parseTranscript ordena as linhas e normaliza as regiões", () => {
  const page = parseTranscript("AAAA-BBB", response([line(300, "segunda linha"), line(200, "primeira linha")]));
  assert.ok(page);
  assert.equal(page.blocks.length, 2);
  assert.deepEqual(
    page.blocks[1].map((l) => l.text),
    ["primeira linha", "segunda linha"],
  );
  assert.deepEqual(page.blocks[1][0].region, { x: 0.1, y: 0.1, width: 0.8, height: 0.02 });
  assert.equal(pageText(page), "110\n\nprimeira linha\nsegunda linha");
  assert.equal(parseTranscript("X", { stuff: { pages: [], regions: [] } }), null);
  assert.equal(parseTranscript("X", null), null);
});

test("foldWord unifica grafias e editDistance para no limite", () => {
  assert.equal(foldWord("Sinezia"), foldWord("Synesia"));
  assert.equal(foldWord("Pachêco,"), "pacheco");
  assert.equal(foldWord("Philomena"), foldWord("Filomena"));
  assert.equal(editDistance("sinesia", "sinesio", 1), 1);
  assert.equal(editDistance("sinesia", "manoel", 2), 3);
});

test("searchPage acha nomes com erro de leitura, palavra partida e devolve a região", () => {
  const page = parseTranscript(
    "AAAA-BBB",
    response([
      line(200, "Aos vinte de Março de mil novecentos e seis, precedidas as denun-"),
      line(240, "ciações canonicas, assisti o recebimento matrimonial de Ma-"),
      line(280, "noel Candido Pachêco e Synezia Francisca dos Santos, elle filho"),
      line(320, "de João Pacheco e Maria Joaquina"),
      line(900, "Aos trinta de Março ... José Ferreira e Sinesia Maria da Conceição"),
    ]),
  )!;
  const hits = searchPage(page, ["Manoel", "Sinesia", "Pacheco"], {}, 87);
  assert.equal(hits.length, 2);
  const [best, other] = hits;
  assert.equal(best.imageNumber, 87);
  assert.deepEqual(best.terms.sort(), ["Manoel", "Pacheco", "Sinesia"]);
  assert.equal(best.matches.find((m) => m.term === "Manoel")?.found, "Manoel");
  assert.equal(best.matches.find((m) => m.term === "Sinesia")?.found, "Synezia");
  assert.match(best.snippet, /Pachêco e Synezia/);
  // A região inclui a margem à esquerda e fica dentro da imagem.
  assert.ok(best.region.x < 0.1 && best.region.y < 0.12 && best.region.y + best.region.height <= 1);
  // A outra Sinesia só reúne um termo, mas a linha do Pacheco do pai fica na janela do primeiro trecho.
  assert.ok(other.terms.length >= 1);

  // Exigindo os três nomes, só o primeiro trecho serve; sem tolerância, "Synezia" ainda casa pela grafia unificada.
  assert.equal(searchPage(page, ["Manoel", "Sinesia", "Pacheco"], { minTerms: 3 }).length, 1);
  assert.equal(searchPage(page, ["Manoel", "Sinesia", "Pacheco"], { minTerms: 3, fuzzy: false }).length, 1);
  // Expressão de várias palavras precisa aparecer em sequência.
  assert.equal(searchPage(page, ["Francisca dos Santos"], {}).length, 1);
  assert.equal(searchPage(page, ["Santos Francisca"], {}).length, 0);
});

test("marksInRegion separa a margem do corpo, descarta ruído e rotula", () => {
  // Página de 1000×2000 px: margem em x=20, corpo a partir de x=150; o "↔" é ruído do reconhecimento.
  const at = (x: number, y: number, w: number, text: string) => ({ rect: `${x},${y},${w},40`, tokens: [{ text }] });
  const page = parseTranscript(
    "AAAA-BBB",
    response([
      at(20, 200, 60, "94"),
      at(150, 200, 800, "Aos vinte tres de Maio de mil novecentos e cinco"),
      at(20, 240, 100, "Manoel"),
      at(150, 240, 800, "das as denunciações canonicas sem impedimento"),
      at(120, 280, 10, "↔"),
      at(150, 280, 800, "perante as testemunhas Pedro Targino dos Santos"),
      at(400, 320, 300, "Vigº José Euphº de Maria"),
      at(150, 1500, 800, "fora do recorte"),
    ]),
  )!;
  const marks = marksInRegion(page, { x: 0, y: 0.05, width: 1, height: 0.45 });
  assert.deepEqual(
    marks.map((m) => `${m.label}:${m.text}`),
    ["A:94", "1:Aos vinte tres de Maio de mil novecentos e cinco", "B:Manoel", "2:das as denunciações canonicas sem impedimento", "3:perante as testemunhas Pedro Targino dos Santos", "4:Vigº José Euphº de Maria"],
  );
});
