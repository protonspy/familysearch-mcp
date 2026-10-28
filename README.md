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
| `FAMILYSEARCH_MIN_IMAGE_INTERVAL_MS` | Intervalo mínimo antes de cada download de imagem (padrão `1500`) |
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
| `fs_get_document_info` | Imagem digitalizada de um registro sem baixá-la: pasta no filme, imagem N de M, citação, vizinhas, região do assento e índice de todas as entradas da página |
| `fs_view_document` | Devolve a imagem do documento para leitura/transcrição: recorte automático do assento, zoom por `region`, grade de coordenadas, realce de tinta desbotada, rotação e navegação para a página anterior/seguinte |
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

### Análise de documentos

O índice de um registro costuma trazer só parte do que está escrito no assento (idades, residência, causa da morte,
testemunhas, notas à margem). Para ler o documento original:

1. `fs_get_document_info` com o id do registro → pasta, imagem N de M, região do assento e as outras entradas da página.
2. `fs_view_document` com o mesmo id → página inteira, ou só o assento quando o indexador marcou a região.
3. Para ampliar: chame de novo com `grid: true` e depois `region: {x, y, width, height}` usando as coordenadas dos
   rótulos da grade (sempre relativas à imagem inteira). `enhance: true` ajuda com tinta desbotada.
4. Assentos que continuam na página seguinte: `step: 1` (ou `-1` para a anterior).

Imagens de coleções restritas (ex.: vários registros de igreja) retornam erro de permissão: só podem ser vistas em
um Centro de História da Família ou biblioteca afiliada. O índice continua disponível.

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
| `GET /platform/records/records/{id}` | `application/x-fs-v1+json` | Entrada de registro (ark 1:2): todas as pessoas e a região na imagem |
| `GET /platform/records/images/3:1:{id}` | `application/x-fs-v1+json` | Metadados da imagem: pasta, citação, `links.self.offset/results`, `prev`/`next` |
| `GET /platform/records/images/3:1:{id}/records` | `application/x-fs-v1+json` | Entradas indexadas na imagem |
| `GET /service/records/storage/deepzoomcloud/dz/v1/3:1:{id}/dist.jpg` | `image/*, */*` | Imagem em resolução total (também `image.xml`, `thumb_p200.jpg`) |

Observações do mapeamento:

- `api.familysearch.org` responde 406 a esse token; o host correto é `www.familysearch.org`.
- `/platform/records/search` foi descontinuado (404); a busca de registros usa `/service/search/hr/v2/personas`.
- Parâmetros de busca: `q.<campo>`, datas com `q.<campo>.from`/`.to`, exatidão com `q.<campo>.exact=on`,
  coleção com `f.collectionId`.
- Na descendência, `1.2` é o 2º filho de `1` com o cônjuge `1-S1`; `1-S2.1` é o 1º filho com o cônjuge `1-S2`.
- `display.gender` vem traduzido ("Masculino"); o sexo é lido de `gender.type`.
- A persona aponta para a imagem por uma `sourceDescription` `DigitalArtifact` (ark 3:1). A descrição `Record` a
  referencia em `sources[]`, às vezes com o qualificador `RectangleRegion` (`x1,y1,x2,y2` normalizados), que é a
  posição do assento na página.
- Imagens restritas respondem 403 no `dist.jpg` e não trazem os links `image-deepzoom`/`image-stream-*` nos metadados.
  Com `Accept: image/*` apenas, o erro vira 406.
- Rajadas de requisições disparam uma proteção anti-robô que responde 200 com HTML ("Pardon Our Interruption");
  o cliente detecta isso e devolve um erro pedindo para aguardar.

## Desenvolvimento

```bash
npm test          # testes unitários (numeração, parentesco, GEDCOM, imagens)
npm run smoke     # integração real: requer FAMILYSEARCH_TOKEN ou FAMILYSEARCH_TOKEN_FILE
npm run inspect   # MCP Inspector
```
