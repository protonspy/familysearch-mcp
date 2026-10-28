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

## Extensão do Chrome (recomendado)

Com a extensão instalada, o MCP **pega o token sozinho** da sua sessão logada e faz as consultas **pelo seu
navegador**, de dentro de uma aba do FamilySearch. Assim você não precisa copiar o token, que expira, e evita os
bloqueios anti-robô que o site aplica a clientes que não são navegadores, como acontece com o download de imagens.

1. Inicie o MCP uma vez. Ele cria `extension/config.json`, com a porta e uma chave secreta.
2. Abra `chrome://extensions`, ative o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e escolha a pasta
   `extension/` deste repositório.
3. Faça login no FamilySearch nesse Chrome.

A tool `fs_browser_status` mostra se a extensão está conectada e de onde vem o token.

- **Segurança:** a ponte escuta só em `127.0.0.1` e aceita apenas extensões (`Origin: chrome-extension://`) que
  apresentem a chave. A extensão só executa `GET` em `/platform/` e `/service/` do FamilySearch e `POST` em
  `/search/filmdatainfo/film-data`, a consulta de leitura que lista as imagens de um filme digital. Fora de
  `www.familysearch.org`, só lê a transcrição automática de uma página (`GET` em `sg30p0.familysearch.org`, sem cookies).
- **Atualização:** depois de atualizar o repositório, recarregue a extensão em `chrome://extensions`. `fs_get_film`
  precisa da versão 0.2.0 ou superior; `fs_search_book_text` e `fs_get_image_text` pela extensão, da 0.3.0.
- **Fallback:** sem o Chrome aberto, o MCP volta ao modo direto com o último token recebido (ou o de
  `FAMILYSEARCH_TOKEN`/`FAMILYSEARCH_TOKEN_FILE`).
- **Verificações anti-robô:** a extensão não as resolve. Se aparecer uma, conclua no navegador.
- **Ritmo:** o limite entre requisições continua valendo. Como as consultas saem da sua sessão, evite rajadas muito
  grandes para não ter o próprio navegador bloqueado.

## Autenticação manual (sem extensão)

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
| `FAMILYSEARCH_BRIDGE_PORT` | Porta local da ponte com a extensão (padrão `17345`; `0` desativa) |
| `FAMILYSEARCH_IMAGE_CACHE_DIR` | Cache em disco das imagens de documentos (padrão `~/.familysearch-mcp/images`) |
| `FAMILYSEARCH_DOWNLOADS_DIR` | Onde procurar imagens baixadas pelo botão do visualizador, salvas como `{id}.jpg` (padrão `~/Downloads`) |

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
| `fs_browser_status` | Conexão com a extensão do Chrome, origem do token e instruções de instalação |
| `fs_set_session_token` | Troca o token de sessão manualmente (desnecessário com a extensão) |
| `fs_whoami` | Usuário logado e o id da sua pessoa na árvore |
| `fs_search_tree` | Busca pessoas na Árvore Familiar (nome, datas, locais, pais, cônjuge) |
| `fs_search_records` | Busca registros históricos, com facetas para refinar por coleção/local/período |
| `fs_get_record` | Registro completo: pessoa principal, fatos, demais pessoas, citação e pessoas da árvore ligadas |
| `fs_get_document_info` | Imagem digitalizada de um registro sem baixá-la: pasta no filme (com o `waypointId` de cada pasta), imagem N de M, citação, vizinhas, região do assento e índice de todas as entradas da página |
| `fs_browse_images` | Navega as pastas de imagens de uma coleção (local > paróquia/cartório > livro > imagens), inclusive livros sem índice |
| `fs_search_full_text` | Busca nas transcrições automáticas (IA) das imagens, com trechos do texto em volta dos termos |
| `fs_search_catalog` | O que existe microfilmado/digitalizado de um lugar no Catálogo |
| `fs_get_catalog_item` | Filmes de um item do catálogo: conteúdo de cada um, nº do microfilme e do filme digital (DGS) |
| `fs_get_film` | Imagens de um filme digital pelo número DGS (requer a extensão) |
| `fs_search_book_text` | Procura nomes nas transcrições automáticas de todas as páginas de um livro, tolerando grafias, e devolve trecho + região de cada acerto |
| `fs_get_image_text` | Transcrição automática de uma página, opcionalmente linha a linha com a região de cada linha |

`fs_view_document` com `markLines: true` numera sobre a imagem as linhas da transcrição automática (corpo 1, 2, 3…;
coluna da margem A, B…) e devolve o texto de cada uma. Combinado com `enhance: true`, serve para transcrever um assento
linha a linha e deixar a leitura conferível por quem olha a imagem.
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

### Pesquisa complementar (livros sem índice)

Muitos livros estão digitalizados mas não indexados: a busca de registros não os encontra. Caminhos para chegar a eles:

1. **Texto completo:** `fs_search_full_text` com nomes, local e período procura nas transcrições automáticas das páginas,
   inclusive padrinhos e testemunhas. A transcrição erra: confirme na imagem com `fs_view_document` (`"3:1:<imageId>"`).
2. **Pastas da coleção:** a partir de qualquer registro do mesmo lugar, `fs_get_document_info` mostra as pastas acima da
   imagem com o `waypointId`. `fs_browse_images` com a pasta da paróquia lista todos os livros dela (batismos,
   matrimônios, óbitos); com a pasta de um livro, lista as imagens numeradas para ler em sequência.
3. **Catálogo e filmes:** `fs_search_catalog` com o local (ex.: `"Brasil, Paraíba, Bananeiras"`) → `fs_get_catalog_item`
   mostra o conteúdo de cada filme e o número do filme digital → `fs_get_film` lista as imagens desse filme.
4. **Livro inteiro de uma vez:** em vez de folhear, `fs_search_book_text` com o `waypointId` do livro (ou os `imageIds`
   de um filme) e os nomes procurados lê a transcrição de todas as páginas e devolve os trechos onde os nomes aparecem
   juntos, aceitando variações (Sinesia/Sinezia/Synesia, Manoel/Manuel) e palavras partidas na translineação. Cada
   acerto traz `region` para recortar o assento com `fs_view_document`. As transcrições ficam em cache em
   `~/.familysearch-mcp/text` (`FAMILYSEARCH_TEXT_CACHE_DIR`): a primeira leitura de um livro leva ~0,4 s por página
   e as seguintes são instantâneas.

As imagens são procuradas nesta ordem, para evitar requisições repetidas:

1. memória (últimas 4);
2. cache em disco;
3. arquivo `{id}.jpg` na pasta Downloads, baixado pelo botão de download do visualizador;
4. rede: pela extensão, quando conectada; senão, direto.

Depois de um bloqueio anti-robô no modo direto, o download direto de imagens fica em pausa por 30 minutos.

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
| `GET /platform/records/collections/{cc}/waypoints` | `application/x-gedcomx-v1+json` | Pastas de 1º nível de uma coleção de imagens |
| `GET /platform/records/waypoints/{id}?cc={cc}` | `application/x-gedcomx-v1+json` | Pasta: subpastas (`Collection`) ou imagens do livro (`DigitalArtifact`); sem `cc` responde 400 |
| `GET /service/search/fulltext/search?q.text=&q.recordPlace=&q.recordYear.from=&q.recordYear.to=&q.collectionId=` | `application/json` | Texto completo: `entries[].content.textDocument`, `highlightTexts`, facetas |
| `GET /service/search/catalog/v3/search?q.place=&q.place.exact=on` | `application/json` | Catálogo (`searchHits[].metadataHit.metadata`) |
| `GET /service/search/catalog/item/{id}` | `application/json` | Item do catálogo (`source.film_note[]`: `filmno`, `digital_film_no`, `text`) |
| `POST /search/filmdatainfo/film-data` | `application/json` | Imagens de um filme digital; corpo `{"type":"film-data","args":{"dgsNum":"004016084",...}}` |
| `GET sg30p0…/service/records/volunteer/orchestration/sls/image/records/3:1:{id}` | `application/json` | Transcrição automática da página (`stuff.regions[].lines[].tokens[]`, retângulos `x,y,w,h` em pixels); exige `FS-User-Agent-Chain` e Bearer, sem cookies |

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
  o cliente detecta isso e devolve um erro pedindo para aguardar. O bloqueio pode durar horas para clientes que não
  são navegadores, enquanto o mesmo download pelo Chrome logado continua funcionando.
- Um Chrome controlado por automação (Playwright/CDP) é barrado na entrada do site (Error 15). Por isso a integração
  usa uma extensão no Chrome normal do usuário, e não um navegador aberto pelo MCP.

## Desenvolvimento

```bash
npm test          # testes unitários (numeração, parentesco, GEDCOM, imagens)
npm run smoke     # integração real: requer FAMILYSEARCH_TOKEN ou FAMILYSEARCH_TOKEN_FILE
npm run inspect   # MCP Inspector
```
