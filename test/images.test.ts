import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { parseDocumentId } from "../src/api.js";
import { clampRegion, gridStep, gridValues, padRegion, parseRectangleRegion, renderImage } from "../src/imaging.js";

test("parseDocumentId distingue persona, entrada e imagem", () => {
  assert.deepEqual(parseDocumentId("QLZ1-89HC"), { kind: "persona", id: "QLZ1-89HC" });
  assert.deepEqual(parseDocumentId("https://familysearch.org/ark:/61903/1:1:QLZ1-89HC"), { kind: "persona", id: "QLZ1-89HC" });
  assert.deepEqual(parseDocumentId("ark:/61903/1:2:QPXJ-LQQ8"), { kind: "record", id: "QPXJ-LQQ8" });
  assert.deepEqual(parseDocumentId("https://familysearch.org/ark:/61903/3:1:S3HY-6DWJ-XX?cc=2015754&wc=WPL6"), {
    kind: "image",
    id: "S3HY-6DWJ-XX",
  });
  assert.deepEqual(parseDocumentId("3Q9M-C95G-39YP-C"), { kind: "image", id: "3Q9M-C95G-39YP-C" });
  assert.throws(() => parseDocumentId("nada"));
});

test("parseRectangleRegion converte x1,y1,x2,y2 em região normalizada", () => {
  assert.deepEqual(parseRectangleRegion("0.116011,0.581501,0.886025,0.74"), { x: 0.116, y: 0.5815, width: 0.77, height: 0.1585 });
  assert.equal(parseRectangleRegion("1,2,3"), undefined);
  assert.equal(parseRectangleRegion(undefined), undefined);
});

test("clampRegion e padRegion mantêm o recorte dentro da imagem", () => {
  assert.deepEqual(clampRegion({ x: 0.9, y: -0.2, width: 0.5, height: 2 }), { x: 0.5, y: 0, width: 0.5, height: 1 });
  assert.deepEqual(padRegion({ x: 0.01, y: 0.5, width: 0.2, height: 0.1 }, 0.05), { x: 0, y: 0.45, width: 0.3, height: 0.2 });
});

test("grade usa passos redondos e coordenadas absolutas", () => {
  assert.equal(gridStep(1), 0.1);
  assert.equal(gridStep(0.3), 0.05);
  assert.equal(gridStep(0.05), 0.005);
  assert.deepEqual(gridValues(0.2, 0.3, 0.1).map((v) => v.toFixed(1)), ["0.2", "0.3", "0.4"]);
});

test("renderImage recorta, limita o tamanho e gira", async () => {
  const source = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();

  const full = await renderImage(source, { maxSize: 1000 });
  assert.deepEqual([full.width, full.height, full.sourceWidth], [1000, 500, 4000]);

  const crop = await renderImage(source, { maxSize: 800, region: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 }, grid: true, enhance: true });
  assert.deepEqual([crop.width, crop.height], [800, 400]);
  const meta = await sharp(crop.data).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [800, 400, "jpeg"]);

  // Recortes pequenos não são ampliados além de 3x.
  const tiny = await renderImage(source, { maxSize: 3000, region: { x: 0, y: 0, width: 0.05, height: 0.05 } });
  assert.deepEqual([tiny.width, tiny.height, tiny.scale], [600, 300, 3]);

  const rotated = await renderImage(source, { maxSize: 1000, rotate: 90 });
  assert.deepEqual([rotated.width, rotated.height], [500, 1000]);
});
