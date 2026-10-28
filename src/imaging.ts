import sharp from "sharp";

/** Região retangular em coordenadas normalizadas (0–1) relativas à imagem inteira. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderOptions {
  region?: Region;
  /** Maior lado da imagem gerada, em pixels. */
  maxSize: number;
  /** Tons de cinza + equalização local de contraste + nitidez, para tinta desbotada e papel manchado. */
  enhance?: boolean;
  rotate?: 0 | 90 | 180 | 270;
  /** Sobrepõe uma grade rotulada com coordenadas absolutas (0–1) da imagem inteira, para pedir recortes precisos. */
  grid?: boolean;
}

export interface RenderedImage {
  data: Buffer;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  region: Region;
  /** Pixels de saída por pixel da imagem original. */
  scale: number;
}

const FULL: Region = { x: 0, y: 0, width: 1, height: 1 };
/** Ampliar além disso só borra a imagem sem revelar detalhe novo. */
const MAX_UPSCALE = 3;

/** Converte um `RectangleRegion` do GEDCOM X ("x1,y1,x2,y2" normalizados) em Region. */
export function parseRectangleRegion(value?: string): Region | undefined {
  const nums = value?.split(",").map(Number);
  if (!nums || nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return undefined;
  const [x1, y1, x2, y2] = nums;
  return clampRegion({ x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) });
}

/** Mantém a região dentro da imagem e com tamanho mínimo utilizável. */
export function clampRegion(r: Region, minSize = 0.01): Region {
  const width = Math.min(1, Math.max(minSize, r.width));
  const height = Math.min(1, Math.max(minSize, r.height));
  return {
    x: round4(Math.min(1 - width, Math.max(0, r.x))),
    y: round4(Math.min(1 - height, Math.max(0, r.y))),
    width: round4(width),
    height: round4(height),
  };
}

/** Expande a região em `margin` (fração da imagem inteira) para cada lado. */
export function padRegion(r: Region, margin: number): Region {
  return clampRegion({ x: r.x - margin, y: r.y - margin, width: r.width + 2 * margin, height: r.height + 2 * margin });
}

/** Maior passo "redondo" que ainda produz ao menos 6 linhas de grade na extensão dada. */
export function gridStep(extent: number) {
  return [0.25, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002].find((step) => extent / step >= 6 - 1e-9) ?? 0.001;
}

export async function renderImage(source: Buffer, opts: RenderOptions): Promise<RenderedImage> {
  const meta = await sharp(source).metadata();
  const sourceWidth = meta.width ?? 0;
  const sourceHeight = meta.height ?? 0;
  if (!sourceWidth || !sourceHeight) throw new Error("Não foi possível ler as dimensões da imagem.");

  const region = clampRegion(opts.region ?? FULL);
  const left = Math.floor(region.x * sourceWidth);
  const top = Math.floor(region.y * sourceHeight);
  const cropWidth = Math.max(1, Math.min(sourceWidth - left, Math.round(region.width * sourceWidth)));
  const cropHeight = Math.max(1, Math.min(sourceHeight - top, Math.round(region.height * sourceHeight)));

  const scale = Math.min(MAX_UPSCALE, opts.maxSize / Math.max(cropWidth, cropHeight));
  const width = Math.max(1, Math.round(cropWidth * scale));
  const height = Math.max(1, Math.round(cropHeight * scale));

  // Etapas separadas: o sharp aplica nitidez e redimensionamento antes do CLAHE dentro de um mesmo pipeline,
  // e o CLAHE exige imagem de 8 bits.
  let data = await sharp(source)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize(width, height, { kernel: "lanczos3" })
    .png()
    .toBuffer();
  if (opts.enhance) data = await sharp(data).grayscale().clahe({ width: 48, height: 48, maxSlope: 3 }).png().toBuffer();
  let pipeline = sharp(data);
  if (opts.enhance) pipeline = pipeline.sharpen();
  if (opts.grid) pipeline = pipeline.composite([{ input: Buffer.from(gridSvg(width, height, region)), top: 0, left: 0 }]);
  data = await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();

  // A rotação vem depois da grade para que os rótulos continuem indicando coordenadas da imagem original.
  const rotated = opts.rotate === 90 || opts.rotate === 270;
  if (opts.rotate) data = await sharp(data).rotate(opts.rotate).jpeg({ quality: 85, mozjpeg: true }).toBuffer();

  return {
    data,
    mimeType: "image/jpeg",
    width: rotated ? height : width,
    height: rotated ? width : height,
    sourceWidth,
    sourceHeight,
    region,
    scale: round4(scale),
  };
}

function gridSvg(width: number, height: number, r: Region) {
  const parts: string[] = [];
  const font = Math.max(11, Math.round(Math.min(width, height) / 70));
  const label = (x: number, y: number, text: string, anchor: string) =>
    `<text x="${x}" y="${y}" font-size="${font}" text-anchor="${anchor}" font-family="sans-serif" fill="#c00000" stroke="#ffffff" stroke-width="3" paint-order="stroke">${text}</text>`;

  const xStep = gridStep(r.width);
  for (const v of gridValues(r.x, r.width, xStep)) {
    const px = ((v - r.x) / r.width) * width;
    if (px < 2) continue;
    parts.push(`<line x1="${px}" y1="0" x2="${px}" y2="${height}" stroke="#ff0000" stroke-opacity="0.45" stroke-width="1"/>`);
    parts.push(label(px, font + 2, formatCoord(v, xStep), "middle"));
  }
  const yStep = gridStep(r.height);
  for (const v of gridValues(r.y, r.height, yStep)) {
    const py = ((v - r.y) / r.height) * height;
    if (py < 2) continue;
    parts.push(`<line x1="0" y1="${py}" x2="${width}" y2="${py}" stroke="#ff0000" stroke-opacity="0.45" stroke-width="1"/>`);
    parts.push(label(4, py - 3, formatCoord(v, yStep), "start"));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
}

/** Múltiplos de `step` dentro de [start, start + extent), calculados por índice para não acumular erro de ponto flutuante. */
export function gridValues(start: number, extent: number, step: number) {
  const values: number[] = [];
  for (let i = Math.ceil(start / step - 1e-9); i * step < start + extent - 1e-9; i++) values.push(i * step);
  return values;
}

/** Casas decimais suficientes para representar o passo exatamente (0.25 → 2, 0.1 → 1, 0.005 → 3). */
function formatCoord(value: number, step: number) {
  const decimals = [1, 2, 3, 4].find((d) => Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-9) ?? 4;
  return value.toFixed(decimals);
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
