#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { FamilySearchApi } from "./api.js";
import { BrowserBridge, DEFAULT_BRIDGE_PORT, EXTENSION_DIR, ensureBridgeConfig } from "./bridge.js";
import { FamilySearchClient } from "./client.js";
import { registerTools } from "./tools.js";

// O cliente (e o token) fica fora da fábrica para sobreviver entre conexões.
const api = new FamilySearchApi(new FamilySearchClient());

// Ponte com a extensão do Chrome: por padrão as requisições saem do navegador e o token vem da sessão logada.
const bridgePort = Number(process.env.FAMILYSEARCH_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT);
if (bridgePort > 0) {
  try {
    const bridge = new BrowserBridge(bridgePort, ensureBridgeConfig(EXTENSION_DIR, bridgePort));
    bridge
      .start()
      .then(() => api.client.attachBridge(bridge))
      // stdout é do protocolo MCP; avisos vão para stderr.
      .catch((err) => console.error(`[familysearch-mcp] ponte com a extensão desativada: ${err.message}`));
  } catch (err) {
    console.error(`[familysearch-mcp] ponte com a extensão desativada: ${(err as Error).message}`);
  }
}

if (!api.client.hasToken()) {
  console.error("[familysearch-mcp] sem token: conecte a extensão do Chrome, defina FAMILYSEARCH_TOKEN ou use fs_set_session_token.");
}

serveStdio(() => {
  const server = new McpServer({ name: "familysearch", version: "0.1.0" });
  registerTools(server, api);
  return server;
});
