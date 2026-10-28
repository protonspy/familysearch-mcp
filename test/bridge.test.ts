import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { BrowserBridge, ensureBridgeConfig } from "../src/bridge.js";
import { BotChallengeError, FamilySearchClient } from "../src/client.js";
import { ImageStore } from "../src/images.js";

const KEY = "k".repeat(48);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

/** Simula a extensão: conecta, informa o token e responde às requisições com `reply`. */
async function fakeExtension(port: number, reply: (msg: any) => object, opts: { key?: string; origin?: string } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?key=${opts.key ?? KEY}`, { origin: opts.origin ?? "chrome-extension://abc" });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "request") ws.send(JSON.stringify({ type: "response", id: msg.id, ...reply(msg) }));
  });
  ws.send(JSON.stringify({ type: "token", token: "tok-from-browser" }));
  return ws;
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond());
};

test("ensureBridgeConfig cria a chave uma vez e a reutiliza", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fs-bridge-"));
  const key = ensureBridgeConfig(dir, 17345);
  assert.equal(ensureBridgeConfig(dir, 17345), key);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8")), { port: 17345, key });
  assert.notEqual(ensureBridgeConfig(dir, 17346), key);
});

test("a ponte recusa chave errada e origem que não é de extensão", async () => {
  const bridge = new BrowserBridge(0, KEY);
  const port = await bridge.start();
  await assert.rejects(fakeExtension(port, () => ({}), { key: "x".repeat(48) }));
  await assert.rejects(fakeExtension(port, () => ({}), { origin: "https://evil.example" }));
  assert.equal(bridge.connected, false);
});

test("porta ocupada (outra sessão do MCP) rejeita o start sem derrubar o processo", async () => {
  const port = await new BrowserBridge(0, KEY).start();
  await assert.rejects(new BrowserBridge(port, KEY).start(), /EADDRINUSE/);
});

test("com a extensão conectada, o cliente usa o token e as requisições do navegador", async () => {
  const bridge = new BrowserBridge(0, KEY);
  const port = await bridge.start();
  const seen: any[] = [];
  const ext = await fakeExtension(port, (msg) => {
    seen.push(msg);
    if (msg.path.endsWith("dist.jpg")) return { status: 200, contentType: "text/html", base64: Buffer.from("<html>Pardon Our Interruption</html>").toString("base64") };
    return { status: 200, contentType: "application/json", base64: Buffer.from('{"ok":true}').toString("base64") };
  });
  const client = new FamilySearchClient("https://www.familysearch.org", "pt", 0, 0);
  client.attachBridge(bridge);
  await until(() => client.hasToken());
  assert.equal(client.tokenSource, "extension");

  assert.deepEqual(await client.get("/platform/x", { query: { a: 1 } }), { ok: true });
  assert.equal(seen[0].path, "/platform/x?a=1");
  assert.equal(seen[0].headers.Authorization, "Bearer tok-from-browser");
  assert.equal(seen[0].method, undefined);

  // POST de consulta: método, corpo JSON e Content-Type chegam à extensão.
  assert.deepEqual(await client.post("/search/filmdatainfo/film-data", { type: "film-data" }), { ok: true });
  assert.equal(seen[1].method, "POST");
  assert.deepEqual(JSON.parse(seen[1].body), { type: "film-data" });
  assert.equal(seen[1].headers["Content-Type"], "application/json");
  seen.length = 1;

  await assert.rejects(client.getBinary("/service/records/storage/deepzoomcloud/dz/v1/3:1:AAAA-BBBB-CC/dist.jpg"), (err) => {
    assert.ok(err instanceof BotChallengeError);
    assert.equal(err.viaBrowser, true);
    return true;
  });
  // Verificação vinda do navegador não pausa o modo direto.
  assert.equal(client.status().directImagesBlockedUntil, undefined);
  ext.close();
});

test("ImageStore usa cache e Downloads antes da rede e grava no cache", async () => {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "fs-cache-"));
  const downloadsDir = mkdtempSync(path.join(tmpdir(), "fs-dl-"));
  let calls = 0;
  const client = {
    baseUrl: "https://www.familysearch.org",
    getBinary: async () => {
      calls++;
      return { data: JPEG, contentType: "image/jpeg" };
    },
  };
  const store = new ImageStore(client, cacheDir, downloadsDir);

  writeFileSync(path.join(downloadsDir, "AAAA-BBBB-CC.jpg"), JPEG);
  assert.equal((await store.get("AAAA-BBBB-CC")).source, "downloads");
  assert.equal((await new ImageStore(client, cacheDir, downloadsDir).get("AAAA-BBBB-CC")).source, "cache");
  assert.equal((await store.get("AAAA-BBBB-CC")).source, "memória");
  assert.equal(calls, 0);

  assert.equal((await store.get("ZZZZ-YYYY-XX")).source, "rede");
  assert.equal(calls, 1);
  assert.deepEqual(readFileSync(path.join(cacheDir, "ZZZZ-YYYY-XX.jpg")), JPEG);
});
