"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Move, RotateCcw, Trash2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { filterStyle } from "@/components/FilterPicker";
import type { FilterId } from "@/lib/api";
import { coverRect, MAX_ADJUST_ZOOM, NO_ADJUST, renderPose, type Adjust } from "@/lib/frames";
import styles from "./adjust.module.css";

type Src = HTMLCanvasElement;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Full-screen editor for one pose: drag to move the photo inside its window,
 * pinch (or the slider) to zoom. The preview is drawn with the same crop maths
 * as the final collage, so what the guest sees is what gets composed.
 */
export default function AdjustSheet({
  src,
  aspect,
  filter,
  value,
  label,
  onDone,
  onRetake,
  onRemove,
}: {
  src: Src;
  /** width/height of the window the pose fills */
  aspect: number;
  filter: FilterId;
  value: Adjust | undefined;
  /** "Pose 2" / "Foto 3" */
  label: string;
  onDone: (adj: Adjust) => void;
  onRetake: () => void;
  /** moments only: drop this photo */
  onRemove?: () => void;
}) {
  const [adj, setAdj] = useState<Adjust>(value ?? NO_ADJUST);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ adj: Adjust; dist: number; x: number; y: number } | null>(null);

  // no page scroll behind the sheet
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // redraw the preview whenever the placement changes (filter via CSS, like the thumbnails)
  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    const w = Math.max(1, Math.round(box.clientWidth * Math.min(2, window.devicePixelRatio || 1)));
    const pose = renderPose(src, aspect, w, "none", adj);
    canvas.width = pose.width;
    canvas.height = pose.height;
    canvas.getContext("2d")!.drawImage(pose, 0, 0);
  }, [src, aspect, adj]);

  /** Moves the photo by a drag of (dx, dy) screen pixels, starting from `from`. */
  const moved = (from: Adjust, dx: number, dy: number): Adjust => {
    const box = boxRef.current;
    if (!box) return from;
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    const { cw, ch } = coverRect(src, bw, bh, from);
    // one screen pixel = cw / bw source pixels; x/y span the free room on each side
    const roomX = (src.width - cw) / 2;
    const roomY = (src.height - ch) / 2;
    return {
      ...from,
      x: roomX > 0.5 ? clamp(from.x + (dx * (cw / bw)) / roomX, -1, 1) : 0,
      y: roomY > 0.5 ? clamp(from.y + (dy * (ch / bh)) / roomY, -1, 1) : 0,
    };
  };

  const start = () => {
    const pts = [...pointers.current.values()];
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { adj, dist, x: cx, y: cy };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    start();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    let next = g.adj;
    if (pts.length > 1 && g.dist > 0) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      next = { ...next, zoom: clamp((g.adj.zoom * dist) / g.dist, 1, MAX_ADJUST_ZOOM) };
    }
    setAdj(moved(next, cx - g.x, cy - g.y));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) start();
    else gesture.current = null;
  };

  const zoomBy = (z: number) => setAdj((a) => ({ ...a, zoom: clamp(z, 1, MAX_ADJUST_ZOOM) }));

  return (
    <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={`Atur ${label}`}>
      <header className={styles.head}>
        <strong>Atur {label}</strong>
        <span>
          <Move /> Geser foto · cubit untuk zoom
        </span>
      </header>

      <div className={styles.stage}>
        <div
          ref={boxRef}
          className={styles.box}
          style={{ aspectRatio: String(aspect), width: `min(100%, calc(var(--stage-h) * ${aspect.toFixed(4)}))` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <canvas ref={canvasRef} style={filterStyle(filter)} />
          <span className={styles.grid} aria-hidden="true" />
        </div>
      </div>

      <div className={styles.zoomRow}>
        <button type="button" onClick={() => zoomBy(adj.zoom - 0.25)} aria-label="Perkecil">
          <ZoomOut />
        </button>
        <input
          type="range"
          min={1}
          max={MAX_ADJUST_ZOOM}
          step={0.01}
          value={adj.zoom}
          onChange={(e) => zoomBy(Number(e.target.value))}
          aria-label="Zoom"
        />
        <button type="button" onClick={() => zoomBy(adj.zoom + 0.25)} aria-label="Perbesar">
          <ZoomIn />
        </button>
      </div>

      <div className={styles.actions}>
        <button type="button" className="btn btn-light btn-sm" onClick={() => setAdj(NO_ADJUST)}>
          <Undo2 /> Reset
        </button>
        <button type="button" className="btn btn-light btn-sm" onClick={onRetake}>
          <RotateCcw /> Ulang foto
        </button>
        {onRemove && (
          <button type="button" className="btn btn-light btn-sm" onClick={onRemove}>
            <Trash2 /> Hapus
          </button>
        )}
      </div>
      <button type="button" className="btn btn-primary btn-block btn-lg" onClick={() => onDone(adj)}>
        <Check /> Selesai
      </button>
    </div>
  );
}
