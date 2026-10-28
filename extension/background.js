// Ponte entre o familysearch-mcp (WebSocket em 127.0.0.1) e a sessão do FamilySearch neste navegador.
// - Envia o token da sessão (cookie fssessionid) ao MCP, inclusive quando ele muda.
// - Executa GETs de leitura em /platform e /service de dentro de uma aba do FamilySearch.
// Não resolve verificações anti-robô: se uma aparecer, o MCP recebe a página e avisa o usuário.

const ORIGIN = "https://www.familysearch.org";
const ALLOWED_PATH = /^\/(platform|service)\/[^\s]*$/;
const ALLOWED_HEADERS = new Set(["accept", "authorization", "accept-language"]);
const MAX_RETRY_MS = 30_000;

let ws;
let connecting = false;
let retryMs = 1000;

async function loadConfig() {
  // Gerado pelo MCP ao iniciar (porta + chave secreta); relido a cada conexão para acompanhar mudanças.
  const res = await fetch(chrome.runtime.getURL("config.json"), { cache: "no-store" });
  if (!res.ok) throw new Error("config.json ausente: inicie o familysearch-mcp ao menos uma vez");
  return res.json();
}

function scheduleReconnect() {
  setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
}

async function connect() {
  if (connecting || (ws && ws.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  try {
    const { port, key } = await loadConfig();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?key=${encodeURIComponent(key)}`);
    ws = socket;
    socket.onopen = () => {
      retryMs = 1000;
      send({ type: "hello", version: chrome.runtime.getManifest().version });
      sendToken();
    };
    socket.onmessage = (event) => handle(JSON.parse(event.data));
    socket.onclose = () => {
      if (ws === socket) ws = undefined;
      scheduleReconnect();
    };
  } catch {
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function sendToken() {
  const cookie = await chrome.cookies.get({ url: ORIGIN, name: "fssessionid" });
  send({ type: "token", token: cookie?.value ?? null });
}

async function handle(msg) {
  if (msg.type === "ping") return send({ type: "pong" });
  if (msg.type !== "request") return;
  try {
    if (!ALLOWED_PATH.test(msg.path)) throw new Error(`caminho não permitido: ${msg.path}`);
    const headers = Object.fromEntries(Object.entries(msg.headers ?? {}).filter(([k]) => ALLOWED_HEADERS.has(k.toLowerCase())));
    const result = await fetchInFamilySearchTab(msg.path, headers);
    send({ type: "response", id: msg.id, ...result });
  } catch (err) {
    send({ type: "error", id: msg.id, message: String(err?.message ?? err) });
  }
}

/** Uma aba do FamilySearch já aberta ou, se não houver, uma nova em segundo plano. */
async function familySearchTab() {
  const tabs = await chrome.tabs.query({ url: `${ORIGIN}/*` });
  const ready = tabs.find((t) => t.status === "complete" && !t.discarded) ?? tabs[0];
  if (ready) return ready.id;
  const tab = await chrome.tabs.create({ url: `${ORIGIN}/pt/`, active: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(reject, new Error("a aba do FamilySearch não carregou")), 30_000);
    const listener = (id, info) => id === tab.id && info.status === "complete" && done(resolve);
    const done = (fn, arg) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      fn(arg);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return tab.id;
}

async function fetchInFamilySearchTab(path, headers) {
  const tabId = await familySearchTab();
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [path, headers],
    func: async (p, h) => {
      const res = await fetch(p, { headers: h, credentials: "include" });
      const bytes = new Uint8Array(await res.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return {
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        retryAfter: res.headers.get("retry-after"),
        base64: btoa(binary),
      };
    },
  });
  if (!injection?.result) throw new Error("não foi possível executar a requisição na aba do FamilySearch (faça login no site)");
  return injection.result;
}

chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (cookie.name === "fssessionid" && cookie.domain.endsWith("familysearch.org")) sendToken();
});

// O service worker pode ser encerrado pelo Chrome; o alarme o acorda para reconectar.
chrome.alarms.create("reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
