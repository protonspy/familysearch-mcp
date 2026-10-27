#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { FamilySearchApi } from "./api.js";
import { FamilySearchClient } from "./client.js";
import { registerTools } from "./tools.js";

// O cliente (e o token) fica fora da fábrica para sobreviver entre conexões.
const api = new FamilySearchApi(new FamilySearchClient());

if (!api.client.hasToken()) {
  // stdout é do protocolo MCP; avisos vão para stderr.
  console.error("[familysearch-mcp] FAMILYSEARCH_TOKEN não definido — use a tool fs_set_session_token.");
}

serveStdio(() => {
  const server = new McpServer({ name: "familysearch", version: "0.1.0" });
  registerTools(server, api);
  return server;
});
