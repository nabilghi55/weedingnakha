// Animated, framed QR card drawn on a canvas. One renderer is used for the
// live screen (/qr), the print PNG and the recorded video, so they all match.
import QR from "qrcode";
import type { WeddingEvent } from "./api";
import { eventKicker, eventMonogram, eventName, formatShortDate } from "./format";
import { BRAND } from "./brand";

export type CardFormat = "card" | "story";

export const CARD_SIZES: Record<CardFormat, { w: number; h: number; label: string }> = {
  card: { w: 1080, h: 1350, label: "Kartu 4:5" },
  story: { w: 1080, h: 1920, label: "Story 9:16" },
};

/** Length of one animation loop in seconds (video = 2 loops). */
export const LOOP = 4;

export interface CardTheme {
  accent: string;
  serif: string;
  sans: string;
}

export function readTheme(): CardTheme {
  const css = getComputedStyle(document.documentElement);
  return {
    accent: css.getPropertyValue("--accent").trim() || "#5b2226",
    serif: css.getPropertyValue("--font-playfair").trim() || "Georgia, serif",
    sans: css.getPropertyValue("--font-jakarta").trim() || "sans-serif",
  };
}

export function qrMatrix(url: string) {
  const qr = QR.create(url, { errorCorrectionLevel: "H" });
  return { size: qr.modules.size, at: (x: number, y: number) => qr.modules.data[y * qr.modules.size + x] === 1 };
}

const INK = "#1c0507";
const PAPER = "#ffffff";
const IVORY = "#fdf4e8";

const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

function txt(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  font: string,
  color: string,
  opts: { spacing?: number; alpha?: number; maxWidth?: number } = {},
) {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = color;
  ctx.globalAlpha = opts.alpha ?? 1;
  if (opts.spacing) ctx.letterSpacing = `${opts.spacing}px`;
  ctx.fillText(s, x, y, opts.maxWidth);
  ctx.restore();
}

function sparkle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, rot: number, color: string, alpha = 1) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const rad = i % 2 === 0 ? r : r * 0.22;
    const a = (i * Math.PI) / 4;
    ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Draws the card at time `t` (seconds).
 * `intro` plays a one-off entrance during the first second (used for video).
 */
export function drawCard(
  ctx: CanvasRenderingContext2D,
  format: CardFormat,
  t: number,
  ev: WeddingEvent,
  qr: ReturnType<typeof qrMatrix>,
  theme: CardTheme,
  opts: { intro?: boolean; still?: boolean; url?: string } = {},
) {
  const { w: W, h: H } = CARD_SIZES[format];
  const story = format === "story";
  const cx = W / 2;
  const loop = opts.still ? 0.35 : (t % LOOP) / LOOP; // 0..1
  const intro = opts.intro ? ease(t / 1.1) : 1;
  const rise = (delay: number) => (opts.intro ? ease((t - delay) / 0.9) : 1);

  // ---- background: accent "doors" like the invitation cover
  ctx.fillStyle = theme.accent;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = "#000";
  for (let x = 0; x < W; x += 54) ctx.fillRect(x, 0, 2, H);
  ctx.restore();
  const vignette = ctx.createRadialGradient(cx, H * 0.42, W * 0.1, cx, H * 0.5, W * 0.95);
  vignette.addColorStop(0, "rgba(255,255,255,0.10)");
  vignette.addColorStop(1, "rgba(0,0,0,0.28)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);

  // ---- inner paper card
  const m = 64;
  const cardY = m + (1 - intro) * 40;
  ctx.save();
  ctx.globalAlpha = intro;
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 50;
  ctx.shadowOffsetY = 20;
  ctx.fillStyle = IVORY;
  ctx.beginPath();
  ctx.roundRect(m, cardY, W - m * 2, H - m * 2, 44);
  ctx.fill();
  ctx.restore();
  // thin inner border
  ctx.save();
  ctx.globalAlpha = intro * 0.9;
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(m + 22, cardY + 22, W - (m + 22) * 2, H - (m + 22) * 2, 30);
  ctx.stroke();
  ctx.restore();

  // ---- header
  const top = cardY + (story ? 330 : 128);
  txt(ctx, eventKicker(ev), cx, top, `800 26px ${theme.sans}`, theme.accent, { spacing: 9, alpha: rise(0.2) });
  const namesY = top + (story ? 130 : 108);
  const nameSize = story ? 104 : 92;
  txt(ctx, eventName(ev), cx, namesY + (1 - rise(0.3)) * 30, `italic 500 ${nameSize}px ${theme.serif}`, INK, {
    alpha: rise(0.3),
    maxWidth: W - m * 2 - 120,
  });
  txt(ctx, formatShortDate(ev), cx, namesY + 58, `700 26px ${theme.sans}`, "#8a6a66", { spacing: 10, alpha: rise(0.4) });

  // ---- QR block
  const qrBox = story ? 600 : 520;
  const boxX = cx - qrBox / 2;
  const boxY = namesY + (story ? 150 : 110);
  const appear = rise(0.5);
  ctx.save();
  ctx.globalAlpha = appear;
  ctx.translate(cx, boxY + qrBox / 2);
  const pop = opts.intro ? 0.92 + 0.08 * appear : 1;
  ctx.scale(pop, pop);
  ctx.translate(-cx, -(boxY + qrBox / 2));
  ctx.fillStyle = PAPER;
  ctx.shadowColor = "rgba(28, 5, 7,0.12)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 10;
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, qrBox, qrBox, 32);
  ctx.fill();
  ctx.shadowColor = "transparent";

  // modules (quiet zone handled by padding)
  const pad = 52;
  const cell = (qrBox - pad * 2) / qr.size;
  ctx.fillStyle = INK;
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.at(x, y)) ctx.fillRect(boxX + pad + x * cell, boxY + pad + y * cell, Math.ceil(cell), Math.ceil(cell));
    }
  }

  // center monogram badge (H error correction tolerates it)
  const badge = cell * 7;
  ctx.fillStyle = PAPER;
  ctx.beginPath();
  ctx.arc(cx, boxY + qrBox / 2, badge / 2 + 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = theme.accent;
  ctx.beginPath();
  ctx.arc(cx, boxY + qrBox / 2, badge / 2, 0, Math.PI * 2);
  ctx.fill();
  txt(ctx, eventMonogram(ev), cx, boxY + qrBox / 2 + badge * 0.16, `italic 500 ${badge * 0.42}px ${theme.serif}`, "#fff");

  // scanning line (animated)
  if (!opts.still) {
    const sy = boxY + pad + (qrBox - pad * 2) * (0.5 - 0.5 * Math.cos(loop * Math.PI * 2));
    const grad = ctx.createLinearGradient(0, sy - 40, 0, sy + 4);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, theme.accent);
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = grad;
    ctx.fillRect(boxX + pad - 10, sy - 40, qrBox - pad * 2 + 20, 44);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = theme.accent;
    ctx.fillRect(boxX + pad - 10, sy, qrBox - pad * 2 + 20, 4);
    ctx.restore();
  }
  ctx.restore();

  // corner brackets (breathing)
  const breathe = opts.still ? 0 : Math.sin(loop * Math.PI * 2) * 8;
  const g = 26 + breathe;
  const len = 70;
  ctx.save();
  ctx.globalAlpha = appear;
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 8;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const corners: [number, number, number, number][] = [
    [boxX - g, boxY - g, 1, 1],
    [boxX + qrBox + g, boxY - g, -1, 1],
    [boxX - g, boxY + qrBox + g, 1, -1],
    [boxX + qrBox + g, boxY + qrBox + g, -1, -1],
  ];
  for (const [x, y, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(x, y + dy * len);
    ctx.lineTo(x, y + dy * 18);
    ctx.quadraticCurveTo(x, y, x + dx * 18, y);
    ctx.lineTo(x + dx * len, y);
    ctx.stroke();
  }
  ctx.restore();

  // floating sparkles
  if (!opts.still) {
    const spin = loop * Math.PI * 2;
    sparkle(ctx, boxX - 70, boxY + 40, 18, spin, theme.accent, appear * (0.5 + 0.5 * Math.sin(spin)));
    sparkle(ctx, boxX + qrBox + 70, boxY + qrBox - 60, 24, -spin, theme.accent, appear * (0.5 + 0.5 * Math.cos(spin)));
    sparkle(ctx, boxX + qrBox + 50, boxY + 20, 10, spin * 1.5, theme.accent, appear * 0.6);
  } else {
    sparkle(ctx, boxX - 70, boxY + 40, 18, 0, theme.accent, 0.8);
    sparkle(ctx, boxX + qrBox + 70, boxY + qrBox - 60, 24, 0.4, theme.accent, 0.8);
  }

  // ---- call to action
  const ctaY = boxY + qrBox + (story ? 150 : 112);
  txt(ctx, "Scan & kirim fotomu", cx, ctaY + (1 - rise(0.7)) * 24, `800 ${story ? 64 : 56}px ${theme.sans}`, INK, {
    spacing: -1.5,
    alpha: rise(0.7),
  });
  txt(ctx, "Fotomu langsung tampil di layar acara", cx, ctaY + 52, `500 28px ${theme.sans}`, "#6b4446", { alpha: rise(0.8) });

  // pill with hashtag / url
  const footY = H - m - (story ? 210 : 96);
  // never print the tokenised check-in URL on the card — only the site host
  const label = ev.hashtag || (opts.url ? opts.url.replace(/^https?:\/\//, "").split(/[/?#]/)[0] : "");
  if (label) {
    ctx.save();
    ctx.globalAlpha = rise(0.9);
    ctx.font = `800 26px ${theme.sans}`;
    ctx.letterSpacing = "2px";
    const tw = ctx.measureText(label).width + 64;
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.roundRect(cx - tw / 2, footY - 40, tw, 60, 30);
    ctx.fill();
    ctx.restore();
    txt(ctx, label, cx, footY, `800 26px ${theme.sans}`, "#fff", { spacing: 2, alpha: rise(0.9) });
  }
  txt(ctx, `Photobooth oleh ${BRAND.name} · ${BRAND.instagram}`, cx, footY + 62, `600 22px ${theme.sans}`, "#6b4446", {
    spacing: 1,
    alpha: rise(0.9),
  });
}

/** Renders one still frame and returns it as a PNG blob (2× for print). */
export async function cardPng(format: CardFormat, ev: WeddingEvent, url: string, scale = 2): Promise<Blob> {
  const { w, h } = CARD_SIZES[format];
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  drawCard(ctx, format, 0, ev, qrMatrix(url), readTheme(), { still: true, url });
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Gagal membuat gambar."))), "image/png"));
}

export function pickVideoType() {
  const types = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  return types.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) ?? "";
}

/** Records the animation (intro + 2 loops) to a video blob. */
export function recordCardVideo(
  format: CardFormat,
  ev: WeddingEvent,
  url: string,
  onProgress: (p: number) => void,
): Promise<{ blob: Blob; ext: string }> {
  const type = pickVideoType();
  if (!type) return Promise.reject(new Error("Browser ini tidak mendukung rekam video. Coba pakai Chrome."));
  const { w, h } = CARD_SIZES[format];
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const qr = qrMatrix(url);
  const theme = readTheme();
  const duration = 1.2 + LOOP * 2;

  return new Promise((resolve, reject) => {
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onerror = () => reject(new Error("Gagal merekam video."));
    rec.onstop = () => resolve({ blob: new Blob(chunks, { type: type.split(";")[0] }), ext: type.includes("mp4") ? "mp4" : "webm" });

    const start = performance.now();
    const frame = () => {
      const t = (performance.now() - start) / 1000;
      drawCard(ctx, format, t, ev, qr, theme, { intro: true, url });
      onProgress(Math.min(1, t / duration));
      if (t < duration) requestAnimationFrame(frame);
      else rec.stop();
    };
    drawCard(ctx, format, 0, ev, qr, theme, { intro: true, url });
    rec.start(250);
    requestAnimationFrame(frame);
  });
}
