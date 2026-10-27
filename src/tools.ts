import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ANCESTRY_MAX_GENERATIONS, DESCENDANCY_MAX_GENERATIONS, FamilySearchApi, type SearchQuery } from "./api.js";
import { FamilySearchError } from "./client.js";
import { EXTENSIONS, type ExportFormat, exportTree } from "./export.js";
import { FamilyTree, TreeBuilder, findRelationship } from "./tree.js";

const personId = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4}-[A-Z0-9]{2,4}$/, "Id de pessoa do FamilySearch no formato XXXX-XXX")
  .describe("Id da pessoa na Árvore Familiar do FamilySearch (ex.: KWQS-BBQ)");

const yearOrRange = z.string().describe('Ano ("1890") ou intervalo ("1880-1900")');

const searchCriteria = {
  givenName: z.string().optional().describe("Prenome(s)"),
  surname: z.string().optional().describe("Sobrenome"),
  sex: z.enum(["Male", "Female"]).optional(),
  birthLikeDate: yearOrRange.optional().describe('Ano ou intervalo de nascimento/batismo ("1890" ou "1880-1900")'),
  birthLikePlace: z.string().optional().describe("Local de nascimento/batismo (ex.: Minas Gerais, Brasil)"),
  deathLikeDate: yearOrRange.optional(),
  deathLikePlace: z.string().optional(),
  marriageLikeDate: yearOrRange.optional(),
  marriageLikePlace: z.string().optional(),
  residenceDate: yearOrRange.optional(),
  residencePlace: z.string().optional(),
  anyPlace: z.string().optional().describe("Qualquer local associado à pessoa"),
  anyDate: yearOrRange.optional(),
  fatherGivenName: z.string().optional(),
  fatherSurname: z.string().optional(),
  motherGivenName: z.string().optional(),
  motherSurname: z.string().optional(),
  spouseGivenName: z.string().optional(),
  spouseSurname: z.string().optional(),
  exactNames: z.boolean().optional().describe("Exigir correspondência exata de nome e sobrenome"),
  filters: z
    .string()
    .optional()
    .describe("Parâmetros extras de refinamento, ex.: o campo `params` de uma faceta retornada por uma busca anterior"),
  count: z.number().int().min(1).max(100).default(20).describe("Resultados por página (máx. 100)"),
  offset: z.number().int().min(0).default(0).describe("Deslocamento para paginação"),
};

const exportFormat = z.enum(["gedcom", "mermaid", "text", "json"]);

const EXPORT_DIR = process.env.FAMILYSEARCH_EXPORT_DIR ?? path.join(homedir(), "familysearch-mcp-exports");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

/** Converte falhas em resultados de erro legíveis pelo modelo em vez de derrubar a chamada. */
function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return text(await fn(args));
    } catch (err) {
      const message =
        err instanceof FamilySearchError
          ? `${err.message} (HTTP ${err.status} em ${new URL(err.url).pathname})`
          : err instanceof Error
            ? err.message
            : String(err);
      return { ...text(`Erro: ${message}`), isError: true };
    }
  };
}

function pickQuery(args: Record<string, unknown>): SearchQuery {
  const { count: _c, offset: _o, collectionId: _col, ...query } = args;
  return query as SearchQuery;
}

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

export function registerTools(server: McpServer, api: FamilySearchApi) {
  const trees = new Map<string, FamilyTree>();
  const builder = new TreeBuilder(api);
  let treeCounter = 0;

  server.registerTool(
    "fs_set_session_token",
    {
      title: "Definir token de sessão",
      description:
        "Define o token de sessão do FamilySearch (valor do cookie `fssessionid` de um navegador logado em familysearch.org). " +
        "Use quando as outras tools retornarem erro 401/token expirado.",
      inputSchema: z.object({ token: z.string().min(10).describe("Valor do cookie fssessionid") }),
    },
    safe(async ({ token }) => {
      api.client.setToken(token);
      const user = await api.currentUser();
      return { ok: true, user };
    }),
  );

  server.registerTool(
    "fs_whoami",
    {
      title: "Usuário atual",
      description: "Verifica a autenticação e retorna o usuário logado, incluindo o id da sua própria pessoa na Árvore Familiar.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    safe(async () => (await api.currentUser()) ?? "Sem usuário."),
  );

  server.registerTool(
    "fs_search_tree",
    {
      title: "Buscar na Árvore Familiar",
      description:
        "Busca pessoas na Árvore Familiar compartilhada do FamilySearch por nome, datas, locais e parentes. " +
        "Retorna ids de pessoa (XXXX-XXX) usados pelas demais tools, com pais/cônjuges/filhos de cada resultado.",
      inputSchema: z.object(searchCriteria),
      annotations: readOnly,
    },
    safe(async (args) => {
      const { facets: _f, ...result } = await api.searchTree(pickQuery(args), args.count, args.offset);
      return result;
    }),
  );

  server.registerTool(
    "fs_search_records",
    {
      title: "Buscar registros históricos",
      description:
        "Busca registros históricos indexados (nascimentos, batismos, casamentos, óbitos, censos, imigração...) no FamilySearch. " +
        "Use `includeFacets` para obter filtros por coleção, local e período; passe o `params` de uma faceta em `filters` para refinar. " +
        "Use fs_get_record com o id do resultado para ver o registro completo.",
      inputSchema: z.object({
        ...searchCriteria,
        collectionId: z.string().optional().describe("Id numérico de uma coleção de registros para restringir a busca"),
        includeFacets: z.boolean().default(false).describe("Incluir facetas (coleções, locais, períodos) para refinamento"),
      }),
      annotations: readOnly,
    },
    safe(async (args) => {
      const { includeFacets, ...rest } = args;
      const result = await api.searchRecords(pickQuery(rest), args.count, args.offset, args.collectionId);
      return includeFacets ? result : { ...result, facets: undefined };
    }),
  );

  server.registerTool(
    "fs_get_person",
    {
      title: "Detalhes da pessoa",
      description: "Lê uma pessoa da Árvore Familiar: nomes, sexo, todos os fatos (nascimento, batismo, casamento, óbito, residência, ocupação...).",
      inputSchema: z.object({ personId }),
      annotations: readOnly,
    },
    safe(async ({ personId }) => (await api.getPerson(personId)) ?? "Pessoa não encontrada."),
  );

  server.registerTool(
    "fs_get_family",
    {
      title: "Família imediata",
      description: "Pais, cônjuges (com casamento) e filhos de uma pessoa, agrupados por casal.",
      inputSchema: z.object({ personId }),
      annotations: readOnly,
    },
    safe(async ({ personId }) => {
      const { persons: _p, ...family } = await api.getFamily(personId);
      return family;
    }),
  );

  server.registerTool(
    "fs_get_ancestors",
    {
      title: "Ascendência (pedigree)",
      description: `Lista os ancestrais de uma pessoa em numeração Ahnentafel (1 = pessoa, 2 = pai, 3 = mãe, 4 = avô paterno...). Até ${ANCESTRY_MAX_GENERATIONS} gerações; para mais, use fs_build_tree.`,
      inputSchema: z.object({ personId, generations: z.number().int().min(1).max(ANCESTRY_MAX_GENERATIONS).default(4) }),
      annotations: readOnly,
    },
    safe(async ({ personId, generations }) => {
      const list = await api.getAncestry(personId, generations);
      return list.map(({ ahnentafel, person }) => ({ ahnentafel, generation: Math.floor(Math.log2(ahnentafel)), ...person }));
    }),
  );

  server.registerTool(
    "fs_get_descendants",
    {
      title: "Descendência",
      description: `Lista os descendentes de uma pessoa (numeração d'Aboville: 1.2 = 2º filho; "-S1" = cônjuge). Até ${DESCENDANCY_MAX_GENERATIONS} gerações; para mais, use fs_build_tree.`,
      inputSchema: z.object({ personId, generations: z.number().int().min(1).max(DESCENDANCY_MAX_GENERATIONS).default(2) }),
      annotations: readOnly,
    },
    safe(async ({ personId, generations }) => (await api.getDescendancy(personId, generations)).map(({ number, person }) => ({ number, ...person }))),
  );

  server.registerTool(
    "fs_get_person_sources",
    {
      title: "Fontes da pessoa",
      description: "Fontes (registros, documentos, citações) anexadas a uma pessoa da Árvore Familiar.",
      inputSchema: z.object({ personId }),
      annotations: readOnly,
    },
    safe(async ({ personId }) => api.getPersonSources(personId)),
  );

  server.registerTool(
    "fs_get_person_memories",
    {
      title: "Memórias da pessoa",
      description: "Fotos, documentos, histórias e áudios (Memórias) anexados a uma pessoa.",
      inputSchema: z.object({ personId }),
      annotations: readOnly,
    },
    safe(async ({ personId }) => api.getPersonMemories(personId)),
  );

  server.registerTool(
    "fs_get_person_notes",
    {
      title: "Notas da pessoa",
      description: "Notas de pesquisa deixadas por colaboradores na pessoa.",
      inputSchema: z.object({ personId }),
      annotations: readOnly,
    },
    safe(async ({ personId }) => api.getPersonNotes(personId)),
  );

  server.registerTool(
    "fs_get_person_changes",
    {
      title: "Histórico de alterações",
      description: "Últimas alterações feitas na pessoa (quem mudou, o quê e por quê). Útil para avaliar a confiabilidade dos dados.",
      inputSchema: z.object({ personId, count: z.number().int().min(1).max(200).default(20) }),
      annotations: readOnly,
    },
    safe(async ({ personId, count }) => api.getPersonChanges(personId, count)),
  );

  server.registerTool(
    "fs_get_record_hints",
    {
      title: "Dicas de registros",
      description: "Registros históricos que o FamilySearch sugere como possivelmente referentes a esta pessoa (record hints pendentes).",
      inputSchema: z.object({ personId, count: z.number().int().min(1).max(100).default(20) }),
      annotations: readOnly,
    },
    safe(async ({ personId, count }) => {
      const { facets: _f, ...result } = await api.getPersonMatches(personId, "records", count);
      return result;
    }),
  );

  server.registerTool(
    "fs_get_possible_duplicates",
    {
      title: "Possíveis duplicatas",
      description: "Outras pessoas da Árvore Familiar que podem ser a mesma pessoa (candidatas a mesclagem).",
      inputSchema: z.object({ personId, count: z.number().int().min(1).max(100).default(20) }),
      annotations: readOnly,
    },
    safe(async ({ personId, count }) => {
      const { facets: _f, ...result } = await api.getPersonMatches(personId, "tree", count);
      return result;
    }),
  );

  server.registerTool(
    "fs_get_record",
    {
      title: "Registro histórico",
      description:
        "Lê um registro histórico indexado: pessoa principal com fatos, demais pessoas do registro (pais, cônjuge, testemunhas), " +
        "coleção/citação e pessoas da Árvore já ligadas a ele.",
      inputSchema: z.object({
        recordId: z.string().describe("Id da persona (ex.: ZWC8-M9ZM, retornado por fs_search_records) ou URL ark:/61903/1:1:..."),
      }),
      annotations: readOnly,
    },
    safe(async ({ recordId }) => (await api.getRecord(recordId)) ?? "Registro não encontrado."),
  );

  server.registerTool(
    "fs_search_places",
    {
      title: "Buscar locais",
      description: "Busca locais no padrão de lugares do FamilySearch (nome completo, tipo, coordenadas). Útil para padronizar locais antes de uma busca.",
      inputSchema: z.object({ name: z.string().min(2), count: z.number().int().min(1).max(50).default(10) }),
      annotations: readOnly,
    },
    safe(async ({ name, count }) => api.searchPlaces(name, count)),
  );

  server.registerTool(
    "fs_find_relationship",
    {
      title: "Calcular parentesco",
      description:
        "Calcula o parentesco entre duas pessoas da Árvore procurando o ancestral comum mais próximo nas ascendências de ambas. " +
        "Retorna o grau (ex.: primo de 2º grau), os ancestrais comuns e o caminho de cada pessoa até eles.",
      inputSchema: z.object({
        personA: personId.describe("Pessoa de referência"),
        personB: personId.describe("Pessoa cujo parentesco com A será descrito"),
        generations: z.number().int().min(1).max(ANCESTRY_MAX_GENERATIONS).default(ANCESTRY_MAX_GENERATIONS),
      }),
      annotations: readOnly,
    },
    safe(async ({ personA, personB, generations }) => findRelationship(api, personA, personB, generations)),
  );

  server.registerTool(
    "fs_build_tree",
    {
      title: "Montar árvore genealógica",
      description:
        "Monta uma árvore genealógica local a partir de uma pessoa, buscando ascendentes e/ou descendentes em várias gerações " +
        "(além dos limites das tools individuais). Retorna um treeId para exportar com fs_export_tree. " +
        "Passe um treeId existente para ampliar uma árvore já montada (ex.: descendentes de um ancestral).",
      inputSchema: z.object({
        personId,
        ancestorGenerations: z.number().int().min(0).max(30).default(6).describe("Gerações de ascendentes (0 = nenhuma)"),
        descendantGenerations: z.number().int().min(0).max(12).default(0).describe("Gerações de descendentes (0 = nenhuma)"),
        maxPersons: z.number().int().min(10).max(10000).default(1000).describe("Limite de segurança de pessoas"),
        treeId: z.string().optional().describe("Árvore existente a ser ampliada"),
      }),
      annotations: readOnly,
    },
    safe(async ({ personId, ancestorGenerations, descendantGenerations, maxPersons, treeId }) => {
      let tree = treeId ? trees.get(treeId) : undefined;
      if (treeId && !tree) throw new Error(`Árvore ${treeId} não encontrada. Use fs_list_trees.`);
      const progress: string[] = [];
      const opts = { ancestorGenerations, descendantGenerations, maxPersons, onProgress: (m: string) => progress.push(m) };
      if (tree) {
        if (ancestorGenerations > 0) await builder.addAncestors(tree, personId, ancestorGenerations, opts);
        if (descendantGenerations > 0) await builder.addDescendants(tree, personId, descendantGenerations, opts);
      } else {
        tree = new FamilyTree(`tree-${++treeCounter}-${personId}`, personId);
        trees.set(tree.id, tree);
        await builder.build(tree, opts);
      }
      return {
        ...tree.stats(),
        truncated: tree.persons.size >= maxPersons,
        log: progress.slice(-10),
        preview: exportTree(tree, "text").split("\n").slice(0, 40).join("\n"),
      };
    }),
  );

  server.registerTool(
    "fs_export_tree",
    {
      title: "Exportar árvore",
      description:
        "Exporta uma árvore montada com fs_build_tree em GEDCOM 5.5.1 (para importar em outros programas de genealogia), " +
        "Mermaid (diagrama), texto (pedigree indentado) ou JSON. Opcionalmente salva em arquivo.",
      inputSchema: z.object({
        treeId: z.string(),
        format: exportFormat.default("text"),
        saveToFile: z.boolean().default(false).describe(`Salvar em arquivo (padrão: ${EXPORT_DIR})`),
        filePath: z.string().optional().describe("Caminho do arquivo de saída (implica saveToFile)"),
      }),
    },
    safe(async ({ treeId, format, saveToFile, filePath }) => {
      const tree = trees.get(treeId);
      if (!tree) throw new Error(`Árvore ${treeId} não encontrada. Use fs_list_trees.`);
      const content = exportTree(tree, format as ExportFormat);
      if (!saveToFile && !filePath) return content;
      const target = path.resolve(filePath ?? path.join(EXPORT_DIR, `${treeId}.${EXTENSIONS[format as ExportFormat]}`));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return { saved: target, bytes: Buffer.byteLength(content), ...tree.stats() };
    }),
  );

  server.registerTool(
    "fs_list_trees",
    {
      title: "Listar árvores montadas",
      description: "Lista as árvores montadas nesta sessão com fs_build_tree.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    safe(async () =>
      [...trees.values()].map((t) => ({ ...t.stats(), rootName: t.persons.get(t.rootId)?.name, createdAt: t.createdAt.toISOString() })),
    ),
  );
}
