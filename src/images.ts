import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { BotChallengeError, type FamilySearchClient, FamilySearchError } from "./client.js";

/** Arquivos do visualizador DeepZoom: `dist.jpg` (resolução total), `image.xml`, `thumb_p200.jpg`. */
export const imageFilePath = (id: string, file: string) => `/service/records/storage/deepzoomcloud/dz/v1/3:1:${id}/${file}`;

export type ImageSource = "memória" | "cache" | "downloads" | "rede";

const RESTRICTED_IMAGE =
  "O FamilySearch não autoriza esta conta a ver esta imagem. Em geral a coleção tem restrição de acesso e a imagem só pode ser " +
  "vista em um Centro de História da Família ou biblioteca afiliada. O índice continua disponível (fs_get_record, fs_get_document_info).";

/** Quantas imagens em resolução total manter em memória para recortes e ampliações sucessivas. */
const MEMORY_SIZE = 4;

const isJpeg = (data: Buffer) => data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;

/**
 * Obtém imagens de documentos evitando ao máximo novas requisições: memória, cache em disco,
 * arquivo baixado pelo botão do visualizador (`{id}.jpg` na pasta Downloads) e só então a rede.
 */
export class ImageStore {
  private readonly memory = new Map<string, Buffer>();

  constructor(
    private readonly client: Pick<FamilySearchClient, "getBinary" | "baseUrl">,
    readonly cacheDir = process.env.FAMILYSEARCH_IMAGE_CACHE_DIR ?? path.join(homedir(), ".familysearch-mcp", "images"),
    readonly downloadsDir = process.env.FAMILYSEARCH_DOWNLOADS_DIR ?? path.join(homedir(), "Downloads"),
  ) {}

  async get(imageId: string): Promise<{ data: Buffer; source: ImageSource }> {
    const cached = this.memory.get(imageId);
    if (cached) {
      this.remember(imageId, cached);
      return { data: cached, source: "memória" };
    }
    const file = `${imageId}.jpg`;
    for (const [dir, source] of [
      [this.cacheDir, "cache"],
      [this.downloadsDir, "downloads"],
    ] as const) {
      const data = await readFile(path.join(dir, file)).catch(() => undefined);
      if (data && isJpeg(data)) {
        if (source === "downloads") await this.saveToCache(file, data);
        this.remember(imageId, data);
        return { data, source };
      }
    }

    const data = await this.download(imageId);
    await this.saveToCache(file, data);
    this.remember(imageId, data);
    return { data, source: "rede" };
  }

  private async download(imageId: string) {
    let res;
    try {
      res = await this.client.getBinary(imageFilePath(imageId, "dist.jpg"));
    } catch (err) {
      if (err instanceof BotChallengeError) {
        throw new FamilySearchError(
          `${err.message} Alternativa: baixe pelo botão de download do visualizador ` +
            `(${this.client.baseUrl}/ark:/61903/3:1:${imageId}); o arquivo ${imageId}.jpg em ${this.downloadsDir} é usado automaticamente.`,
          err.status,
          err.url,
        );
      }
      if (err instanceof FamilySearchError && err.status === 403 && !err.body?.includes("blocked by our security service")) {
        throw new FamilySearchError(RESTRICTED_IMAGE, 403, err.url);
      }
      throw err;
    }
    if (!res?.data.length || !isJpeg(res.data)) throw new Error(`O FamilySearch não devolveu a imagem 3:1:${imageId}.`);
    return res.data;
  }

  private remember(imageId: string, data: Buffer) {
    this.memory.delete(imageId);
    this.memory.set(imageId, data);
    if (this.memory.size > MEMORY_SIZE) this.memory.delete(this.memory.keys().next().value!);
  }

  private async saveToCache(file: string, data: Buffer) {
    // Cache é otimização: falhar ao gravar não deve impedir a leitura do documento.
    await mkdir(this.cacheDir, { recursive: true })
      .then(() => writeFile(path.join(this.cacheDir, file), data))
      .catch(() => undefined);
  }
}
