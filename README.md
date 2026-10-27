# familysearch-mcp

Servidor MCP (TypeScript) para pesquisar no [FamilySearch](https://www.familysearch.org) e montar árvores genealógicas:
busca na Árvore Familiar e em registros históricos, leitura de pessoas, famílias, fontes e memórias,
cálculo de parentesco e montagem de árvores com várias gerações exportáveis em GEDCOM, Mermaid, texto ou JSON.

Todas as tools são **somente leitura**: o servidor não altera a Árvore Familiar compartilhada.

## Instalação

```bash
npm install
npm run build
```

Requer Node.js 20+.

## Autenticação (token de sessão)

O servidor usa o token da sua sessão logada no site, enviado como `Authorization: Bearer`.

1. Entre em https://www.familysearch.org no navegador.
2. Abra o DevTools (F12) → Console e rode:
   ```js
   copy(document.cookie.match(/fssessionid=([^;]+)/)[1])
   ```
3. Cole o valor em um arquivo fora do repositório, ex.: `~/.familysearch-token`.

O token expira depois de algumas horas sem uso. Quando as tools retornarem "token inválido ou expirado",
repita os passos acima ou chame a tool `fs_set_session_token` com o novo valor.

| Variável | Descrição |
| --- | --- |
| `FAMILYSEARCH_TOKEN` | Token de sessão (`fssessionid`) |
| `FAMILYSEARCH_TOKEN_FILE` | Alternativa: caminho de um arquivo contendo o token (lido ao iniciar) |
| `FAMILYSEARCH_LANG` | Idioma dos textos de exibição (padrão `pt`) |
| `FAMILYSEARCH_EXPORT_DIR` | Pasta padrão das exportações (padrão `~/familysearch-mcp-exports`) |
| `FAMILYSEARCH_MIN_INTERVAL_MS` | Intervalo mínimo entre requisições (padrão `150`) |
| `FAMILYSEARCH_USER_AGENT` | User-Agent enviado nas requisições (padrão: Chrome; o firewall do FamilySearch bloqueia UAs não reconhecidos) |

## Uso com Claude Code

```bash
claude mcp add familysearch -e FAMILYSEARCH_TOKEN_FILE=C:/Users/<você>/.familysearch-token -- node C:/caminho/familysearch-mcp/dist/index.js
```

Ou no Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "familysearch": {
      "command": "node",
      "args": ["C:/caminho/familysearch-mcp/dist/index.js"],
      "env": { "FAMILYSEARCH_TOKEN_FILE": "C:/Users/<você>/.familysearch-token" }
    }
  }
}
```

## Tools

| Tool | O que faz |
| --- | --- |
| `fs_set_session_token` | Troca o token de sessão em tempo de execução |
| `fs_whoami` | Usuário logado e o id da sua pessoa na árvore |
| `fs_search_tree` | Busca pessoas na Árvore Familiar (nome, datas, locais, pais, cônjuge) |
| `fs_search_records` | Busca registros históricos, com facetas para refinar por coleção/local/período |
| `fs_get_record` | Registro completo: pessoa principal, fatos, demais pessoas, citação e pessoas da árvore ligadas |
| `fs_get_person` | Nomes e todos os fatos de uma pessoa |
| `fs_get_family` | Pais, cônjuges (com casamento) e filhos |
| `fs_get_ancestors` | Pedigree em numeração Ahnentafel (até 8 gerações) |
| `fs_get_descendants` | Descendência em numeração d'Aboville (até 4 gerações) |
| `fs_get_person_sources` / `_memories` / `_notes` / `_changes` | Fontes, memórias, notas e histórico de alterações |
| `fs_get_record_hints` | Registros sugeridos pelo FamilySearch para a pessoa |
| `fs_get_possible_duplicates` | Possíveis duplicatas na árvore |
| `fs_search_places` | Padronização de locais (nome completo, tipo, coordenadas) |
| `fs_find_relationship` | Parentesco entre duas pessoas via ancestral comum (ex.: "primo de 2º grau") |
| `fs_build_tree` | Monta uma árvore local com N gerações de ascendentes e/ou descendentes |
| `fs_export_tree` | Exporta a árvore em GEDCOM 5.5.1, Mermaid, texto ou JSON (opcionalmente em arquivo) |
| `fs_list_trees` | Árvores montadas na sessão |

Datas de busca aceitam ano (`"1890"`) ou intervalo (`"1880-1900"`).

### Exemplo de fluxo

1. `fs_search_records` com `givenName`, `surname`, `birthLikePlace`, `birthLikeDate` → escolha um registro.
2. `fs_get_record` → veja os pais e as pessoas da árvore ligadas ao registro.
3. `fs_build_tree` a partir do id da árvore com `ancestorGenerations: 12` → `treeId`.
4. `fs_export_tree` com `format: "gedcom"` e `saveToFile: true` → importe no Gramps, MyHeritage, Ancestry etc.

## Rotas do FamilySearch utilizadas

Mapeadas a partir do tráfego do site com uma sessão logada (todas em `https://www.familysearch.org`):

| Rota | Accept | Uso |
| --- | --- | --- |
| `GET /platform/users/current` | `application/x-fs-v1+json` | Usuário atual |
| `GET /platform/tree/persons/{pid}` | `application/x-fs-v1+json` | Pessoa |
| `GET /platform/tree/persons/{pid}/parents` · `/spouses` · `/children` | `application/x-fs-v1+json` | Família |
| `GET /platform/tree/ancestry?person=&generations=≤8&personDetails=true` | `application/x-fs-v1+json` | Ascendência (`display.ascendancyNumber`) |
| `GET /platform/tree/descendancy?person=&generations=≤4&personDetails=true` | `application/x-fs-v1+json` | Descendência (`display.descendancyNumber`) |
| `GET /platform/tree/persons/{pid}/sources` · `/memories` · `/notes` | `application/x-fs-v1+json` | Fontes, memórias, notas |
| `GET /platform/tree/persons/{pid}/changes` | `application/x-gedcomx-atom+json` | Histórico (ignora `count`) |
| `GET /platform/tree/persons/{pid}/matches?collection=records\|tree` | `application/x-gedcomx-atom+json` | Dicas de registros / duplicatas |
| `GET /service/search/tree/v2/personas?q.*` | `application/json` | Busca na Árvore |
| `GET /service/search/hr/v2/personas?q.*&m.defaultFacets=on&m.queryRequireDefault=on` | `application/json` | Busca de registros |
| `GET /platform/records/personas/{id}` | `application/x-fs-v1+json` | Registro (persona) |
| `GET /platform/records/personas/{id}/matches?collection=tree&status=accepted` | `application/x-gedcomx-atom+json` | Pessoas da árvore ligadas ao registro |
| `GET /platform/places/search?q=name:"..."` | `application/x-gedcomx-atom+json` | Locais |

Observações do mapeamento:

- `api.familysearch.org` responde 406 a esse token; o host correto é `www.familysearch.org`.
- `/platform/records/search` foi descontinuado (404); a busca de registros usa `/service/search/hr/v2/personas`.
- Parâmetros de busca: `q.<campo>`, datas com `q.<campo>.from`/`.to`, exatidão com `q.<campo>.exact=on`,
  coleção com `f.collectionId`.
- Na descendência, `1.2` é o 2º filho de `1` com o cônjuge `1-S1`; `1-S2.1` é o 1º filho com o cônjuge `1-S2`.
- `display.gender` vem traduzido ("Masculino"); o sexo é lido de `gender.type`.

## Desenvolvimento

```bash
npm test          # testes unitários (numeração, parentesco, GEDCOM)
npm run smoke     # integração real: requer FAMILYSEARCH_TOKEN ou FAMILYSEARCH_TOKEN_FILE
npm run inspect   # MCP Inspector
```
