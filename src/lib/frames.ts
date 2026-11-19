// Photobooth frame renderer. Takes a square snapshot and composes the final
// framed photo on a canvas, with the chosen filter baked in.
import type { FilterId, WeddingEvent } from "./api";
import { drawFiltered } from "./filters";
import { eventDateTime, eventMonogram, eventName, formatShortDate, isWedding } from "./format";
import { BRAND } from "./brand";

export type FrameId = "custom" | "koran" | "plain" | "classic" | "minimal" | "film" | "accent";

export interface FrameDef {
  id: FrameId;
  name: string;
  desc: string;
  swatch: string; // CSS background for the picker
}

export const FRAMES: FrameDef[] = [
  { id: "plain", name: "Tanpa Bingkai", desc: "Foto saja, tanpa hiasan", swatch: "linear-gradient(135deg,#8a7a6c,#4a1c22)" },
  { id: "koran", name: "Koran", desc: "Halaman depan koran acara", swatch: "linear-gradient(#fbebd9 22%, #111 22% 24%, #6b625a 24%)" },
  { id: "classic", name: "Polaroid", desc: "Putih klasik, nama bergaya tulisan", swatch: "linear-gradient(#ffffff 72%, #f3dcc4 72%)" },
  { id: "minimal", name: "Minimal", desc: "Garis tipis & huruf tegas", swatch: "linear-gradient(#fdf4e8 70%, #1c0507 70% 74%, #fdf4e8 74%)" },
  { id: "film", name: "Film Strip", desc: "Bingkai film gelap", swatch: "repeating-linear-gradient(90deg,#1c0507 0 6px,#4a1c22 6px 9px)" },
  { id: "accent", name: "Warna Tema", desc: "Mengikuti warna acara", swatch: "var(--accent)" },
];

/** The organiser's own frame (transparent PNG uploaded in Admin). */
export const CUSTOM_FRAME: FrameDef = {
  id: "custom",
  name: "Bingkai Acara",
  desc: "Bingkai khusus dari penyelenggara",
  swatch: "var(--accent-soft)",
};

let custom: { url: string; img: HTMLImageElement } | null = null;

/** Loads (once) the event's custom frame so renderFrame can draw it synchronously. */
export function loadCustomFrame(url: string): Promise<boolean> {
  if (custom?.url === url) return Promise.resolve(true);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // keep the canvas exportable
    img.decoding = "async";
    img.onload = () => {
      custom = { url, img };
      resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

const W = 1000;
const PAD = 56;
const PHOTO = W - PAD * 2;

function cssVar(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export async function ensureFrameFonts() {
  const serif = cssVar("--font-playfair", "serif");
  const sans = cssVar("--font-jakarta", "sans-serif");
  // never block the photobooth on a slow/failed font download: render with fallbacks after 2.5 s
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2500));
  try {
    await Promise.race([timeout, Promise.all([
      document.fonts.load(`900 100px ${serif}`),
      document.fonts.load(`400 24px ${cssVar("--font-news", "serif")}`),
      document.fonts.load(`700 24px ${cssVar("--font-news", "serif")}`),
      document.fonts.load(`italic 400 24px ${cssVar("--font-news", "serif")}`),
      document.fonts.load(`italic 500 80px ${serif}`),
      document.fonts.load(`800 40px ${sans}`),
      document.fonts.load(`600 24px ${sans}`),
    ])]);
  } catch {
    /* fall back to whatever is available */
  }
}

function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, font: string, color: string, spacing = 0, maxWidth?: number) {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.fillStyle = color;
  if (spacing) ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(value, x, y, maxWidth);
  ctx.restore();
}

/** Largest font size (≤ max) at which `value` fits in `width`. */
function fitSize(ctx: CanvasRenderingContext2D, value: string, font: (px: number) => string, max: number, width: number) {
  let px = max;
  ctx.save();
  for (; px > 20; px -= 4) {
    ctx.font = font(px);
    if (ctx.measureText(value).width <= width) break;
  }
  ctx.restore();
  return px;
}

/** Splits a long title over two lines at the word boundary nearest the middle. */
function splitTitle(value: string): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  if (value.length <= 16 || words.length < 2) return [value];
  let best = 1;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ").length;
    const b = words.slice(0, best).join(" ").length;
    if (Math.abs(a - value.length / 2) < Math.abs(b - value.length / 2)) best = i;
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

const MASTHEAD = { wedding: "The Wedding Post", campus: "The Campus Post", corporate: "The Company Post" } as const;
const HEADLINE = {
  wedding: 'RESMI BILANG "SAH!"',
  campus: "KABAR GEMBIRA DARI KAMPUS",
  corporate: "MOMEN KEBERSAMAAN KITA",
} as const;

function aligned(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  font: string,
  color: string,
  align: CanvasTextAlign,
  spacing = 0,
  maxWidth?: number,
) {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  if (spacing) ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(value, x, y, maxWidth);
  ctx.restore();
}

type Source = CanvasImageSource & { width: number; height: number };

/** Draws `src` filling the destination rect (centre crop, like object-fit: cover). */
function drawCover(ctx: CanvasRenderingContext2D, src: Source, filter: FilterId, dx: number, dy: number, dw: number, dh: number) {
  const scale = Math.max(dw / src.width, dh / src.height);
  const cw = dw / scale;
  const ch = dh / scale;
  drawFiltered(ctx, src, filter, (src.width - cw) / 2, (src.height - ch) / 2, cw, ch, dx, dy, dw, dh);
}

/** Just the photo (portrait 3:4, 1080×1440 — fits Instagram) with a small studio credit. */
/** Photo fills the whole canvas; the organiser's PNG is laid on top of it. */
function renderCustom(snapshot: Source, filter: FilterId, credit: boolean) {
  if (!custom) return renderPlain(snapshot, filter, credit);
  const { img } = custom;
  const CW = 1080;
  const CH = Math.round((CW * img.naturalHeight) / img.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = CW;
  canvas.height = CH;
  const ctx = canvas.getContext("2d")!;
  drawCover(ctx, snapshot, filter, 0, 0, CW, CH);
  ctx.drawImage(img, 0, 0, CW, CH);
  if (credit) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 6;
    aligned(ctx, BRAND.instagram, CW - 24, CH - 20, `600 20px ${cssVar("--font-jakarta", "sans-serif")}`, "rgba(255,255,255,0.85)", "right", 1);
    ctx.restore();
  }
  return canvas;
}

function renderPlain(snapshot: Source, filter: FilterId, credit: boolean) {
  const SW = 1080;
  const SH = 1440;
  const canvas = document.createElement("canvas");
  canvas.width = SW;
  canvas.height = SH;
  const ctx = canvas.getContext("2d")!;
  drawCover(ctx, snapshot, filter, 0, 0, SW, SH);
  if (credit) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 6;
    aligned(ctx, BRAND.instagram, SW - 28, SH - 28, `600 22px ${cssVar("--font-jakarta", "sans-serif")}`, "rgba(255,255,255,0.85)", "right", 1);
    ctx.restore();
  }
  return canvas;
}

/** Newspaper front page ("The Wedding Post"): masthead, dateline, photo with italic serif names. */
function renderKoran(snapshot: CanvasImageSource & { width: number; height: number }, filter: FilterId, ev: WeddingEvent, credit: boolean) {
  const ink = "#1c0507";
  const paper = "#fbebd9";
  const headline = cssVar("--font-playfair", "Georgia, serif");
  const news = cssVar("--font-news", "Georgia, serif");

  const top = 268; // masthead + dateline
  const PH = Math.round((PHOTO * 4) / 3); // tall 3:4 cover photo
  const base = top + PH;
  const H = base + 112;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const cx = W / 2;
  const L = PAD;
  const R = W - PAD;

  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, W, H);

  // masthead
  const title = MASTHEAD[ev.type ?? "wedding"] ?? MASTHEAD.wedding;
  const mPx = fitSize(ctx, title, (px) => `900 ${px}px ${headline}`, 104, R - L);
  aligned(ctx, title, cx, 148, `900 ${mPx}px ${headline}`, ink, "center", -1);

  // dateline between rules
  const rule = (y: number, h: number) => {
    ctx.fillStyle = ink;
    ctx.fillRect(L, y, R - L, h);
  };
  rule(182, 2);
  const date = eventDateTime(ev)
    .toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })
    .toUpperCase();
  const small = `400 21px ${news}`;
  aligned(ctx, date, L, 218, small, ink, "left", 2, 300);
  aligned(ctx, "EDISI SPESIAL", cx, 218, `700 21px ${news}`, ink, "center", 4);
  aligned(ctx, (ev.venue || (isWedding(ev) ? "Hari Bahagia" : "Hari Istimewa")).toUpperCase(), R, 218, small, ink, "right", 2, 280);
  rule(236, 3);
  rule(243, 1);

  // photo
  drawCover(ctx, snapshot, filter, L, top, PHOTO, PH);

  // soft shading so white type stays legible on any photo
  const shade = (y0: number, y1: number, a0: number, a1: number) => {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, `rgba(0,0,0,${a0})`);
    g.addColorStop(1, `rgba(0,0,0,${a1})`);
    ctx.fillStyle = g;
    ctx.fillRect(L, y0, PHOTO, y1 - y0);
  };
  shade(top, top + PH * 0.42, 0.5, 0);
  shade(base - PH * 0.25, base, 0, 0.55);

  // names, staggered like the classic front-page cover
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 12;
  const nameW = PHOTO * 0.78;
  if (isWedding(ev)) {
    const gPx = fitSize(ctx, ev.groomName, (px) => `italic 500 ${px}px ${headline}`, 112, nameW);
    const bPx = fitSize(ctx, ev.brideName, (px) => `italic 500 ${px}px ${headline}`, 112, nameW);
    aligned(ctx, ev.groomName, L + 48, top + 160, `italic 500 ${gPx}px ${headline}`, "#ffffff", "left");
    aligned(ctx, "dan", cx, top + 222, `italic 400 44px ${headline}`, "#ffffff", "center");
    aligned(ctx, ev.brideName, R - 48, top + 312, `italic 500 ${bPx}px ${headline}`, "#ffffff", "right");
  } else {
    const lines = splitTitle(eventName(ev));
    const font = (px: number) => `italic 500 ${px}px ${headline}`;
    const px = Math.min(...lines.map((l) => fitSize(ctx, l, font, 104, PHOTO - 96)));
    lines.forEach((l, i) => aligned(ctx, l, cx, top + 170 + i * (px + 14), font(px), "#ffffff", "center"));
  }
  ctx.restore();

  // headline
  aligned(ctx, HEADLINE[ev.type ?? "wedding"] ?? HEADLINE.wedding, cx, base - 52, `700 32px ${news}`, "#ffffff", "center", 6, PHOTO - 60);

  // footer
  rule(base + 30, 1);
  const foot = `400 18px ${news}`;
  aligned(ctx, credit ? `${BRAND.name.toUpperCase()} · VOL. I` : "VOL. I · NO. 1", L, base + 70, `700 18px ${news}`, ink, "left", 3);
  aligned(ctx, "HARGA: SATU SENYUMAN", cx, base + 70, `italic 400 19px ${news}`, ink, "center", 1);
  // without credit the right corner stays empty: the server watermark goes there
  if (credit) aligned(ctx, BRAND.instagram.toUpperCase(), R, base + 70, foot, ink, "right", 3);

  return canvas;
}

/**
 * Composes the final photo. `credit: false` leaves out the @seribu.lensa studio
 * credit: that version is what gets uploaded — the server keeps it clean for the
 * couple and stamps its own watermark on the gallery/Live Wall copy. Guests'
 * own downloads and Instagram shares keep the credit.
 */
export function renderFrame(
  snapshot: CanvasImageSource & { width: number; height: number },
  frame: FrameId,
  filter: FilterId,
  ev: WeddingEvent,
  { credit = true }: { credit?: boolean } = {},
) {
  if (frame === "custom") return renderCustom(snapshot, filter, credit);
  if (frame === "koran") return renderKoran(snapshot, filter, ev, credit);
  if (frame === "plain") return renderPlain(snapshot, filter, credit);
  const bottom = frame === "film" ? 230 : 250;
  const top = frame === "film" ? 90 : PAD;
  const H = top + PHOTO + bottom;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  const serif = cssVar("--font-playfair", "Georgia, serif");
  const sans = cssVar("--font-jakarta", "sans-serif");
  const accent = cssVar("--accent", "#5b2226");
  const names = eventName(ev);
  const date = formatShortDate(ev);
  const cx = W / 2;
  const maxText = W - PAD * 2;

  const bg = { classic: "#ffffff", minimal: "#fdf4e8", film: "#1c0507", accent, koran: "#fbebd9", plain: "#000" }[frame];
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Photo
  const side = Math.min(snapshot.width, snapshot.height);
  drawFiltered(ctx, snapshot, filter, (snapshot.width - side) / 2, (snapshot.height - side) / 2, side, side, PAD, top, PHOTO, PHOTO);

  const base = top + PHOTO;

  // studio credit, bottom-right inside the photo
  if (credit) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 6;
    text(ctx, BRAND.instagram, PAD + PHOTO - 110, base - 22, `600 20px ${sans}`, "rgba(255,255,255,0.85)", 1);
    ctx.restore();
  }

  switch (frame) {
    case "classic": {
      ctx.strokeStyle = "rgba(0,0,0,0.06)";
      ctx.lineWidth = 2;
      ctx.strokeRect(PAD, top, PHOTO, PHOTO);
      text(ctx, names, cx, base + 130, `italic 500 78px ${serif}`, "#1c0507", 0, maxText);
      text(ctx, date, cx, base + 190, `600 24px ${sans}`, "#8a6a66", 8);
      break;
    }
    case "minimal": {
      ctx.strokeStyle = "#1c0507";
      ctx.lineWidth = 2;
      ctx.strokeRect(22, 22, W - 44, H - 44);
      text(ctx, "THE WEDDING OF", cx, base + 78, `700 20px ${sans}`, accent, 7);
      text(ctx, names.toUpperCase(), cx, base + 148, `800 60px ${sans}`, "#1c0507", -1, maxText);
      text(ctx, date, cx, base + 200, `600 22px ${sans}`, "#8a6a66", 8);
      break;
    }
    case "film": {
      ctx.fillStyle = "#fdf4e8";
      const hole = { w: 34, h: 22, gap: 30 };
      for (let x = 24; x < W - hole.w; x += hole.w + hole.gap) {
        for (const y of [34, H - 34 - hole.h]) {
          ctx.beginPath();
          ctx.roundRect(x, y, hole.w, hole.h, 5);
          ctx.fill();
        }
      }
      text(ctx, names, cx, base + 100, `italic 500 72px ${serif}`, "#ffffff", 0, maxText);
      text(ctx, date, cx, base + 150, `600 22px ${sans}`, "rgba(255,255,255,0.6)", 8);
      break;
    }
    case "accent": {
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 3;
      ctx.strokeRect(PAD + 18, top + 18, PHOTO - 36, PHOTO - 36);
      // monogram
      const my = base + 70;
      ctx.beginPath();
      ctx.arc(cx, my, 34, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 2;
      ctx.stroke();
      text(ctx, eventMonogram(ev), cx, my + 11, `italic 500 30px ${serif}`, "#ffffff");
      text(ctx, names, cx, base + 170, `italic 500 66px ${serif}`, "#ffffff", 0, maxText);
      text(ctx, date, cx, base + 218, `600 22px ${sans}`, "rgba(255,255,255,0.75)", 8);
      break;
    }
  }

  return canvas;
}

/**
 * Grabs a portrait (3:4) frame from the video, mirrored for the selfie camera.
 * `zoom` > 1 crops the centre (digital zoom, matching the CSS-scaled preview).
 */
export function takeSnapshot(video: HTMLVideoElement, mirror: boolean, zoom = 1, aspect = 3 / 4) {
  // largest centred width:height = aspect rect, then crop further for digital zoom
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  let h = Math.min(vh, vw / aspect);
  let w = h * aspect;
  const z = Math.max(1, zoom);
  w = Math.round(w / z);
  h = Math.round(h / z);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  if (mirror) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, (vw - w) / 2, (vh - h) / 2, w, h, 0, 0, w, h);
  return canvas;
}

/** Photos per photobooth session; they become one 2×2 collage. */
export const COLLAGE_POSES = 4;

/**
 * Photobooth collage ("The Wedding Post" photo page): masthead, dateline, a
 * 2×2 grid of square poses and the couple's names. 1080×1350 (4:5) so it fits
 * an Instagram feed post and the Live Wall alike. Empty slots (while shooting)
 * are drawn as numbered placeholders. `credit: false` leaves the bottom-right
 * corner empty for the server watermark.
 */
export function renderCollage(
  shots: (Source | null | undefined)[],
  filter: FilterId,
  ev: WeddingEvent,
  { credit = true }: { credit?: boolean } = {},
) {
  const CW = 1080;
  const CH = 1350;
  const P = 48;
  const GAP = 18;
  const ink = "#1c0507";
  const paper = "#fbebd9";
  const headline = cssVar("--font-playfair", "Georgia, serif");
  const news = cssVar("--font-news", "Georgia, serif");

  const canvas = document.createElement("canvas");
  canvas.width = CW;
  canvas.height = CH;
  const ctx = canvas.getContext("2d")!;
  const cx = CW / 2;
  const L = P;
  const R = CW - P;
  const rule = (y: number, h: number) => {
    ctx.fillStyle = ink;
    ctx.fillRect(L, y, R - L, h);
  };

  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, CW, CH);

  // masthead + dateline
  const title = MASTHEAD[ev.type ?? "wedding"] ?? MASTHEAD.wedding;
  const mPx = fitSize(ctx, title, (px) => `900 ${px}px ${headline}`, 70, R - L);
  aligned(ctx, title, cx, 88, `900 ${mPx}px ${headline}`, ink, "center", -1);
  rule(108, 2);
  const date = ev.eventDate
    ? eventDateTime(ev).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" }).toUpperCase()
    : "";
  aligned(ctx, date, L, 138, `400 19px ${news}`, ink, "left", 2, 300);
  aligned(ctx, "EDISI PHOTOBOOTH", cx, 138, `700 19px ${news}`, ink, "center", 4);
  aligned(ctx, (ev.venue || (isWedding(ev) ? "Hari Bahagia" : "Hari Istimewa")).toUpperCase(), R, 138, `400 19px ${news}`, ink, "right", 2, 280);
  rule(152, 3);
  rule(159, 1);

  // 2×2 grid of square poses
  const top = 178;
  const cell = (R - L - GAP) / 2;
  for (let i = 0; i < COLLAGE_POSES; i++) {
    const x = L + (i % 2) * (cell + GAP);
    const y = top + Math.floor(i / 2) * (cell + GAP);
    const shot = shots[i];
    if (shot) {
      drawCover(ctx, shot, filter, x, y, cell, cell);
    } else {
      ctx.fillStyle = "rgba(28,5,7,0.08)";
      ctx.fillRect(x, y, cell, cell);
      aligned(ctx, String(i + 1), x + cell / 2, y + cell / 2 + 40, `italic 500 120px ${headline}`, "rgba(28,5,7,0.25)", "center");
    }
  }
  const gridEnd = top + cell * 2 + GAP;

  // names + footer
  ctx.save();
  const names = eventName(ev);
  const nPx = fitSize(ctx, names, (px) => `italic 500 ${px}px ${headline}`, 66, R - L - 40);
  ctx.restore();
  aligned(ctx, names, cx, gridEnd + 82, `italic 500 ${nPx}px ${headline}`, ink, "center", 0, R - L);
  rule(gridEnd + 110, 1);
  const fy = gridEnd + 146;
  aligned(ctx, credit ? BRAND.name.toUpperCase() : "VOL. I · NO. 1", L, fy, `700 18px ${news}`, ink, "left", 3, 300);
  const tag = ev.hashtag?.trim();
  aligned(ctx, tag ? (tag.startsWith("#") ? tag : `#${tag}`) : "HARGA: SATU SENYUMAN", cx, fy, `italic 400 20px ${news}`, ink, "center", 1, 360);
  // without credit the right corner stays empty: the server watermark goes there
  if (credit) aligned(ctx, BRAND.instagram.toUpperCase(), R, fy, `400 18px ${news}`, ink, "right", 3, 300);

  return canvas;
}
