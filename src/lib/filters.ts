import type { FilterId, ThemeId } from "./api";

export interface FilterDef {
  id: FilterId;
  name: string;
  /** small swatch colour for chips */
  color: string;
  /** CSS/canvas filter applied to the photo itself */
  base: string;
  /** optional colour wash drawn over the photo */
  tint?: { color: string; alpha: number; blend: GlobalCompositeOperation };
  /** "photobooth" (clean looks) or "disposable" (film-camera looks with grain & date stamp) */
  group?: FilterGroup;
  /** disposable-camera effects, previewed with CSS overlays and baked on canvas */
  fx?: FilterFx;
}

export type FilterGroup = "photobooth" | "disposable";

export interface FilterFx {
  /** film grain strength 0–1 */
  grain?: number;
  /** dark corners strength 0–1 */
  vignette?: number;
  /** warm light leak glowing in from one edge */
  leak?: { color: string; alpha: number; x: number; y: number };
  /** orange LCD date stamp in the bottom-right corner, like a disposable camera */
  stamp?: boolean;
}

export const FILTER_GROUPS: { id: FilterGroup; name: string }[] = [
  { id: "photobooth", name: "Photobooth" },
  { id: "disposable", name: "Disposable" },
];

/** Filters offered on the camera screen. */
export const FILTERS: FilterDef[] = [
  { id: "none", name: "Original", color: "#d8d2ca", base: "none" },
  { id: "bw", name: "B&W", color: "#2a2623", base: "grayscale(1) contrast(1.18) brightness(1.03)" },
  {
    id: "classic",
    name: "Classic",
    color: "#c9a27a",
    base: "contrast(1.06) saturate(1.12) brightness(1.02) sepia(0.12)",
    tint: { color: "#f2c48d", alpha: 0.12, blend: "soft-light" },
  },
  {
    id: "vintage",
    name: "Vintage",
    color: "#a8875f",
    base: "sepia(0.38) contrast(0.9) saturate(0.78) brightness(1.06)",
    tint: { color: "#d9b38c", alpha: 0.18, blend: "soft-light" },
  },
  {
    id: "softflash",
    name: "Soft Flash",
    color: "#f4e7e1",
    base: "brightness(1.16) contrast(0.88) saturate(0.96)",
    tint: { color: "#ffffff", alpha: 0.1, blend: "screen" },
  },

  /* ---------- Disposable camera ---------- */
  {
    id: "disposable",
    name: "Disposable",
    group: "disposable",
    color: "#e0a35a",
    base: "contrast(1.12) saturate(1.2) brightness(1.05) sepia(0.12)",
    tint: { color: "#ffb35c", alpha: 0.1, blend: "soft-light" },
    fx: { grain: 0.28, vignette: 0.32, stamp: true },
  },
  {
    id: "nightflash",
    name: "Flash Malam",
    group: "disposable",
    color: "#f3efe6",
    base: "brightness(1.14) contrast(1.28) saturate(1.08)",
    tint: { color: "#fff4e0", alpha: 0.08, blend: "screen" },
    fx: { grain: 0.32, vignette: 0.62, stamp: true },
  },
  {
    id: "film400",
    name: "Film 400",
    group: "disposable",
    color: "#7f9a74",
    base: "contrast(0.95) saturate(1.1) brightness(1.04) sepia(0.16)",
    tint: { color: "#2e5a42", alpha: 0.12, blend: "lighten" },
    fx: { grain: 0.38, vignette: 0.25, stamp: true },
  },
  {
    id: "lightleak",
    name: "Light Leak",
    group: "disposable",
    color: "#f07a3a",
    base: "contrast(1.05) saturate(1.12) brightness(1.06) sepia(0.14)",
    tint: { color: "#ffcf9a", alpha: 0.08, blend: "soft-light" },
    fx: { grain: 0.26, vignette: 0.22, leak: { color: "#ff6a2b", alpha: 0.55, x: 1, y: 0.15 }, stamp: true },
  },
  {
    id: "disposablebw",
    name: "Disposable B&W",
    group: "disposable",
    color: "#55504b",
    base: "grayscale(1) contrast(1.24) brightness(1.06)",
    fx: { grain: 0.4, vignette: 0.42, stamp: true },
  },
];

export const filtersInGroup = (g: FilterGroup) => FILTERS.filter((f) => (f.group ?? "photobooth") === g);

/** Disposable-camera date stamp text, e.g. '26 11 24 */
export function stampText(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `'${p(d.getFullYear() % 100)} ${p(d.getMonth() + 1)} ${p(d.getDate())}`;
}

/** Older filters, kept so photos taken with them still render and label correctly. */
const LEGACY_FILTERS: FilterDef[] = [
  {
    id: "warm",
    name: "Hangat",
    color: "#d9a066",
    base: "saturate(1.08) contrast(1.04) brightness(1.03) sepia(0.18)",
    tint: { color: "#ffb36b", alpha: 0.12, blend: "soft-light" },
  },
  {
    id: "film",
    name: "Film",
    color: "#8a9a7b",
    base: "contrast(0.92) saturate(0.82) brightness(1.05) sepia(0.12)",
    tint: { color: "#2f4a3a", alpha: 0.14, blend: "lighten" },
  },
  { id: "mono", name: "Hitam Putih", color: "#3a3532", base: "grayscale(1) contrast(1.12) brightness(1.02)" },
  {
    id: "soft",
    name: "Lembut",
    color: "#e7b8b4",
    base: "brightness(1.08) contrast(0.9) saturate(0.95)",
    tint: { color: "#ffd9d2", alpha: 0.16, blend: "soft-light" },
  },
];

export const filterById = (id: string) => FILTERS.find((f) => f.id === id) ?? LEGACY_FILTERS.find((f) => f.id === id) ?? FILTERS[0];

/* ---------- CSS filter → colour matrix (for browsers without ctx.filter) ---------- */

/** 3×4 affine colour transform: out = M·rgb + offset (0–255 space). */
type ColorMatrix = { m: number[]; o: number[] };

const IDENTITY: ColorMatrix = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], o: [0, 0, 0] };

function compose(a: ColorMatrix, b: ColorMatrix): ColorMatrix {
  // b applied after a
  const m: number[] = [];
  const o: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) m[r * 3 + c] = b.m[r * 3] * a.m[c] + b.m[r * 3 + 1] * a.m[3 + c] + b.m[r * 3 + 2] * a.m[6 + c];
    o[r] = b.m[r * 3] * a.o[0] + b.m[r * 3 + 1] * a.o[1] + b.m[r * 3 + 2] * a.o[2] + b.o[r];
  }
  return { m, o };
}

/** Matrices from the CSS Filter Effects spec. */
function fnMatrix(name: string, v: number): ColorMatrix {
  const k = 1 - v;
  switch (name) {
    case "grayscale":
      return {
        m: [0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k, 0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k, 0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k],
        o: [0, 0, 0],
      };
    case "sepia":
      return {
        m: [0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k, 0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k, 0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k],
        o: [0, 0, 0],
      };
    case "saturate":
      return {
        m: [0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v, 0.213 - 0.213 * v, 0.715 + 0.285 * v, 0.072 - 0.072 * v, 0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v],
        o: [0, 0, 0],
      };
    case "brightness":
      return { m: [v, 0, 0, 0, v, 0, 0, 0, v], o: [0, 0, 0] };
    case "contrast": {
      const off = (0.5 - 0.5 * v) * 255;
      return { m: [v, 0, 0, 0, v, 0, 0, 0, v], o: [off, off, off] };
    }
  }
  return IDENTITY;
}

/** Parses e.g. "sepia(0.3) contrast(0.9)" into one combined matrix. */
export function filterMatrix(css: string): ColorMatrix {
  let acc = IDENTITY;
  for (const [, name, val] of css.matchAll(/([a-z]+)\(([\d.]+)\)/g)) acc = compose(acc, fnMatrix(name, parseFloat(val)));
  return acc;
}

// Feature-test on the prototype: on Safari `ctx.filter = …` just creates a plain
// JS property that reads back fine but does nothing.
function canvasFilterSupported(ctx: CanvasRenderingContext2D) {
  return "filter" in Object.getPrototypeOf(ctx);
}

function applyColorMatrix(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, { m, o }: ColorMatrix) {
  const img = ctx.getImageData(x, y, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    d[i] = m[0] * r + m[1] * g + m[2] * b + o[0];
    d[i + 1] = m[3] * r + m[4] * g + m[5] * b + o[1];
    d[i + 2] = m[6] * r + m[7] * g + m[8] * b + o[2];
  }
  ctx.putImageData(img, x, y); // Uint8ClampedArray clamps to 0–255
}

/** Draws `source` into the given rect with the filter baked in. */
export function drawFiltered(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  filterId: FilterId,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) {
  const f = filterById(filterId);
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  if (f.base === "none") {
    ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
  } else if (canvasFilterSupported(ctx)) {
    ctx.filter = f.base;
    ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.filter = "none";
  } else {
    // Safari (iPhone) ignores ctx.filter: apply the same colour matrix to the pixels
    ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
    applyColorMatrix(ctx, Math.round(dx), Math.round(dy), Math.round(dw), Math.round(dh), filterMatrix(f.base));
  }
  if (f.tint) {
    ctx.globalAlpha = f.tint.alpha;
    ctx.globalCompositeOperation = f.tint.blend;
    ctx.fillStyle = f.tint.color;
    ctx.fillRect(dx, dy, dw, dh);
  }
  if (f.fx) {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    drawFx(ctx, f.fx, dx, dy, dw, dh);
  }
  ctx.restore();
}

let grainTile: HTMLCanvasElement | null = null;

/** 160×160 tile of mid-grey noise, generated once. */
function grain(): HTMLCanvasElement {
  if (grainTile) return grainTile;
  const c = document.createElement("canvas");
  c.width = c.height = 160;
  const g = c.getContext("2d")!;
  const img = g.createImageData(160, 160);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  grainTile = c;
  return c;
}

function drawFx(ctx: CanvasRenderingContext2D, fx: FilterFx, dx: number, dy: number, dw: number, dh: number) {
  const cx = dx + dw / 2;
  const cy = dy + dh / 2;
  const r = Math.hypot(dw, dh) / 2;

  if (fx.leak) {
    const lx = dx + dw * fx.leak.x;
    const ly = dy + dh * fx.leak.y;
    const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, Math.max(dw, dh) * 0.75);
    g.addColorStop(0, fx.leak.color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.save();
    ctx.globalAlpha = fx.leak.alpha;
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = g;
    ctx.fillRect(dx, dy, dw, dh);
    ctx.restore();
  }

  if (fx.vignette) {
    const g = ctx.createRadialGradient(cx, cy, r * 0.45, cx, cy, r);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${fx.vignette})`);
    ctx.fillStyle = g;
    ctx.fillRect(dx, dy, dw, dh);
  }

  if (fx.grain) {
    const pattern = ctx.createPattern(grain(), "repeat");
    if (pattern) {
      ctx.save();
      // keep the grain size similar on small thumbnails and full-size photos
      const scale = Math.max(1, Math.min(dw, dh) / 700);
      ctx.translate(dx, dy);
      ctx.scale(scale, scale);
      ctx.globalAlpha = fx.grain;
      ctx.globalCompositeOperation = "overlay";
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, dw / scale, dh / scale);
      ctx.restore();
    }
  }

  if (fx.stamp) {
    const size = Math.max(10, Math.min(dw, dh) * 0.055);
    ctx.save();
    ctx.font = `700 ${size}px "Courier New", ui-monospace, monospace`;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#ff9a3c";
    ctx.shadowColor = "rgba(255, 110, 30, 0.85)";
    ctx.shadowBlur = size * 0.35;
    ctx.globalAlpha = 0.92;
    ctx.fillText(stampText(), dx + dw - size * 0.9, dy + dh - size * 0.9);
    ctx.restore();
  }
}

export interface ThemeDef {
  id: ThemeId;
  name: string;
  desc: string;
  color: string;
}

export const THEMES: ThemeDef[] = [
  { id: "maroon", name: "Maroon", desc: "Maroon anggur & krem, klasik elegan", color: "#5b2226" },
  { id: "sage", name: "Sage", desc: "Hijau daun yang teduh & natural", color: "#5c6e52" },
  { id: "terracotta", name: "Terracotta", desc: "Jingga bata yang hangat", color: "#b1553a" },
  { id: "navy", name: "Navy", desc: "Biru tua yang tenang & formal", color: "#23334f" },
];
