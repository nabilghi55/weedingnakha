// Designed (code-drawn, non-photo) cover artwork in the event's theme colour.
// No text on purpose: the hero/cover overlays the couple's names on top.

export type CoverStyle = "arch" | "botanical" | "rings" | "petals";

export const COVER_STYLES: { id: CoverStyle; name: string }[] = [
  { id: "arch", name: "Lengkung" },
  { id: "botanical", name: "Botani" },
  { id: "rings", name: "Cincin" },
  { id: "petals", name: "Kelopak" },
];

/** Small deterministic PRNG so previews match the uploaded result. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LINE = "rgba(251, 248, 243, ";

function background(ctx: CanvasRenderingContext2D, w: number, h: number, accent: string) {
  ctx.fillStyle = "#1c0507";
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 0.62;
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
  const g = ctx.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.5, Math.max(w, h) * 0.75);
  g.addColorStop(0, "rgba(255,255,255,0.14)");
  g.addColorStop(0.55, "rgba(255,255,255,0)");
  g.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function grain(ctx: CanvasRenderingContext2D, w: number, h: number, r: () => number) {
  ctx.save();
  for (let i = 0; i < (w * h) / 900; i++) {
    ctx.fillStyle = r() > 0.5 ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.05)";
    ctx.fillRect(r() * w, r() * h, 1.6, 1.6);
  }
  ctx.restore();
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, alpha: number) {
  ctx.save();
  ctx.fillStyle = LINE + alpha + ")";
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const rad = i % 2 === 0 ? s : s * 0.22;
    const a = (i * Math.PI) / 4;
    ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function leaf(ctx: CanvasRenderingContext2D, x: number, y: number, len: number, angle: number, width: number, fill: boolean) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.5, -width, len, 0);
  ctx.quadraticCurveTo(len * 0.5, width, 0, 0);
  if (fill) ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(len * 0.85, 0);
  ctx.stroke();
  ctx.restore();
}

function branch(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, length: number, scale: number, r: () => number) {
  const steps = 9;
  const bend = (r() - 0.5) * 0.9;
  let px = x;
  let py = y;
  let a = angle;
  ctx.beginPath();
  ctx.moveTo(px, py);
  const pts: [number, number, number][] = [];
  for (let i = 1; i <= steps; i++) {
    a += bend / steps;
    px += Math.cos(a) * (length / steps);
    py += Math.sin(a) * (length / steps);
    ctx.lineTo(px, py);
    pts.push([px, py, a]);
  }
  ctx.stroke();
  pts.forEach(([lx, ly, la], i) => {
    const size = scale * (1 - i / (steps + 3)) * (0.8 + r() * 0.4);
    const side = i % 2 === 0 ? 1 : -1;
    leaf(ctx, lx, ly, size, la + side * (0.7 + r() * 0.3), size * 0.32, i % 3 === 0);
  });
  leaf(ctx, px, py, scale * 0.8, a, scale * 0.26, true);
}

export function drawCover(ctx: CanvasRenderingContext2D, style: CoverStyle, w: number, h: number, accent: string, seed = 7) {
  const r = rng(seed + style.length * 101);
  const u = Math.min(w, h) / 1000; // unit scale
  background(ctx, w, h, accent);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  switch (style) {
    case "arch": {
      const cx = w / 2;
      const base = h * 1.02;
      for (let i = 0; i < 7; i++) {
        const half = (180 + i * 95) * u;
        const top = h * 0.2 + i * 46 * u;
        ctx.strokeStyle = LINE + (0.42 - i * 0.045) + ")";
        ctx.lineWidth = (i === 0 ? 3 : 1.6) * u;
        ctx.beginPath();
        ctx.moveTo(cx - half, base);
        ctx.lineTo(cx - half, top + half);
        ctx.arc(cx, top + half, half, Math.PI, 0);
        ctx.lineTo(cx + half, base);
        ctx.stroke();
      }
      for (let i = 0; i < 26; i++) star(ctx, r() * w, r() * h * 0.7, (4 + r() * 10) * u, 0.15 + r() * 0.4);
      break;
    }
    case "botanical": {
      ctx.strokeStyle = LINE + "0.5)";
      ctx.fillStyle = LINE + "0.08)";
      ctx.lineWidth = 2.2 * u;
      const L = 520 * u;
      const S = 70 * u;
      branch(ctx, -20 * u, h * 0.15, 0.25, L, S, r);
      branch(ctx, -20 * u, h * 0.32, -0.35, L * 0.75, S * 0.8, r);
      branch(ctx, w + 20 * u, h * 0.85, Math.PI + 0.25, L, S, r);
      branch(ctx, w + 20 * u, h * 0.68, Math.PI - 0.35, L * 0.75, S * 0.8, r);
      branch(ctx, w * 0.2, h + 20 * u, -1.25, L * 0.6, S * 0.7, r);
      branch(ctx, w * 0.8, -20 * u, 1.9, L * 0.6, S * 0.7, r);
      for (let i = 0; i < 14; i++) star(ctx, w * (0.25 + r() * 0.5), h * (0.1 + r() * 0.8), (3 + r() * 6) * u, 0.12 + r() * 0.25);
      break;
    }
    case "rings": {
      const cy = h * 0.5;
      const R = 330 * u;
      const off = 150 * u;
      for (const [x, a] of [
        [w / 2 - off, 0.45],
        [w / 2 + off, 0.45],
      ] as const) {
        for (let k = 0; k < 3; k++) {
          ctx.strokeStyle = LINE + (a - k * 0.13) + ")";
          ctx.lineWidth = (k === 0 ? 3 : 1.2) * u;
          ctx.beginPath();
          ctx.arc(x, cy, R + k * 34 * u, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      // orbiting dots
      for (let i = 0; i < 90; i++) {
        const a = r() * Math.PI * 2;
        const rad = R * (1.35 + r() * 0.9);
        ctx.fillStyle = LINE + (0.08 + r() * 0.3) + ")";
        ctx.beginPath();
        ctx.arc(w / 2 + Math.cos(a) * rad * 1.3, cy + Math.sin(a) * rad, (1 + r() * 3) * u, 0, Math.PI * 2);
        ctx.fill();
      }
      star(ctx, w / 2, cy - R - 60 * u, 18 * u, 0.7);
      break;
    }
    case "petals": {
      for (let i = 0; i < 70; i++) {
        const x = r() * w;
        const y = r() * h;
        // keep the centre calmer for the names
        const d = Math.hypot((x - w / 2) / w, (y - h / 2) / h);
        if (d < 0.22 && r() > 0.25) continue;
        const s = (18 + r() * 46) * u;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(r() * Math.PI * 2);
        ctx.fillStyle = LINE + (0.06 + r() * 0.16) + ")";
        ctx.strokeStyle = LINE + (0.15 + r() * 0.25) + ")";
        ctx.lineWidth = 1.2 * u;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(s * 0.6, -s * 0.5, s * 1.1, -s * 0.15, s, s * 0.25);
        ctx.bezierCurveTo(s * 0.7, s * 0.6, s * 0.2, s * 0.35, 0, 0);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      break;
    }
  }
  grain(ctx, w, h, r);
}

export function coverCanvas(style: CoverStyle, accent: string, w = 2400, h = 1600) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  drawCover(c.getContext("2d")!, style, w, h, accent);
  return c;
}
