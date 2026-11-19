"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Download,
  Eye,
  EyeOff,
  Images,
  Maximize2,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";
import QRCode from "@/components/QRCode";
import { photoSrc, type EventStats, type ModerationAction, type ModerationTarget, type Photo, type QrInfo } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import styles from "@/app/admin/admin.module.css";
import lb from "@/components/Lightbox.module.css";

/* ---------- Stats ---------- */

export function StatsGrid({ stats }: { stats: EventStats | null }) {
  const cards = [
    { label: "Foto tampil", value: stats?.totalPhotos, icon: Images },
    { label: "Tamu check-in (perangkat)", value: stats?.totalGuests, icon: Users },
    { label: "Tamu mengirim foto", value: stats?.guestsUploaded, icon: Camera },
    { label: "Menunggu persetujuan", value: stats?.pendingApproval, icon: ShieldCheck },
    { label: "Foto 1 jam terakhir", value: stats?.lastHour, icon: Clock },
    { label: "Sedang melihat", value: stats?.liveViewers, icon: Eye },
  ];
  return (
    <div className={styles.statGrid}>
      {cards.map((c) => (
        <div key={c.label} className={`card ${styles.stat}`}>
          <span className={styles.statIcon}>
            <c.icon />
          </span>
          <strong>{c.value ?? "–"}</strong>
          <span>{c.label}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- Moderation ---------- */

interface ModerationProps {
  photos: Photo[];
  onAction: (p: Photo, action: ModerationAction, target: ModerationTarget) => Promise<void>;
  onDelete: (p: Photo) => Promise<void>;
  /** host: direct link to the ZIP of clean photos */
  downloadAllHref?: string;
  /** admin: fetches the ZIP (admin API needs a header) */
  onDownloadAll?: () => Promise<void>;
}

type ModFilter = "all" | "pending" | "hidden";
type KindFilter = "all" | "photobooth" | "moment";

/**
 * Which photobooth mode a photo came from. Photos sent before the mode was
 * recorded are told apart by shape: moments are portrait 3:4 (1080×1440),
 * collages are 9:16 or 4:5.
 */
export function photoKind(p: Photo): "photobooth" | "moment" {
  if (p.source === "moment") return "moment";
  if (p.width && p.height && Math.abs(p.width / p.height - 3 / 4) < 0.02) return "moment";
  return "photobooth";
}

interface ActionCtx {
  busyId: string | null;
  confirmId: string | null;
  setConfirmId: (id: string | null) => void;
  run: (p: Photo, fn: () => Promise<void>) => Promise<void>;
  onAction: ModerationProps["onAction"];
  onDelete: ModerationProps["onDelete"];
}

/** Wall / Galeri visibility toggles + download + delete, compact or with labels. */
function ModActions({ p, ctx, full }: { p: Photo; ctx: ActionCtx; full?: boolean }) {
  const busy = ctx.busyId === p.id;
  if (ctx.confirmId === p.id) {
    return (
      <div className={styles.confirm}>
        <span>Hapus permanen?</span>
        <button className="btn btn-sm btn-ghost" onClick={() => ctx.setConfirmId(null)}>
          Batal
        </button>
        <button className="btn btn-sm btn-danger" onClick={() => ctx.run(p, () => ctx.onDelete(p))} disabled={busy}>
          {busy ? <span className="spinner" /> : "Hapus"}
        </button>
      </div>
    );
  }
  const toggle = (target: "wall" | "gallery", hidden: boolean | undefined, label: string) => (
    <button
      className={`${styles.vis} ${hidden ? styles.visOff : ""}`}
      disabled={busy}
      aria-pressed={!hidden}
      title={hidden ? `Tersembunyi di ${label} — klik untuk tampilkan` : `Tampil di ${label} — klik untuk sembunyikan`}
      onClick={() => ctx.run(p, () => ctx.onAction(p, hidden ? "restore" : "hide", target))}
    >
      {hidden ? <EyeOff /> : <Eye />} {label}
    </button>
  );
  return (
    <div className={`${styles.modActions} ${full ? styles.modActionsFull : ""}`}>
      {p.approval === "PENDING" && (
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => ctx.run(p, () => ctx.onAction(p, "approve", "both"))}>
          <CheckCircle2 /> Setujui
        </button>
      )}
      {toggle("wall", p.hiddenFromWall, "Wall")}
      {toggle("gallery", p.hiddenFromGallery, "Galeri")}
      <span className={styles.modSpacer} />
      {p.downloadUrl && (
        <a className={styles.iconAct} href={photoSrc(p.downloadUrl)} download title="Download tanpa watermark" aria-label="Download tanpa watermark">
          <Download />
          {full && <span>Download</span>}
        </a>
      )}
      <button className={`${styles.iconAct} ${styles.iconDanger}`} onClick={() => ctx.setConfirmId(p.id)} title="Hapus foto" aria-label="Hapus foto">
        <Trash2 />
        {full && <span>Hapus</span>}
      </button>
    </div>
  );
}

/** Full-screen viewer with prev/next (buttons, arrow keys, swipe). */
function ModViewer({ list, index, onIndex, onClose, ctx }: { list: Photo[]; index: number; onIndex: (i: number) => void; onClose: () => void; ctx: ActionCtx }) {
  const p = list[index];
  const count = list.length;
  const [touchX, setTouchX] = useState<number | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") onIndex((index + 1) % count);
      if (e.key === "ArrowLeft") onIndex((index - 1 + count) % count);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [index, count, onIndex, onClose]);
  useEffect(() => {
    if (!p) onClose();
  }, [p, onClose]);
  if (!p) return null;
  const src = p.photoUrl || p.thumbUrl;
  return (
    <div className={lb.backdrop} role="dialog" aria-modal="true" aria-label="Pratinjau foto" onClick={onClose}>
      <div className={lb.frame} onClick={(e) => e.stopPropagation()}>
        <div
          className={lb.imageWrap}
          onTouchStart={(e) => setTouchX(e.touches[0].clientX)}
          onTouchEnd={(e) => {
            if (touchX === null || count < 2) return;
            const dx = e.changedTouches[0].clientX - touchX;
            if (Math.abs(dx) > 50) onIndex(dx < 0 ? (index + 1) % count : (index - 1 + count) % count);
            setTouchX(null);
          }}
        >
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={p.id} src={photoSrc(src)} alt={`Foto dari ${p.guestName}`} className={(p.hiddenFromWall || p.hiddenFromGallery) ? styles.viewerDim : ""} />
          ) : (
            <div className={styles.processing}>
              <span className="spinner" /> Diproses…
            </div>
          )}
          {count > 1 && (
            <>
              <button className={`${lb.nav} ${lb.prev}`} onClick={() => onIndex((index - 1 + count) % count)} aria-label="Sebelumnya">
                <ChevronLeft />
              </button>
              <button className={`${lb.nav} ${lb.next}`} onClick={() => onIndex((index + 1) % count)} aria-label="Berikutnya">
                <ChevronRight />
              </button>
            </>
          )}
        </div>
        <aside className={lb.side}>
          <div className={lb.sideHead}>
            <span className="subtle" style={{ fontSize: "0.78rem" }}>
              {index + 1} / {count} · {timeAgo(p.createdAt)}
            </span>
            <button className="icon-btn" onClick={onClose} aria-label="Tutup">
              <X />
            </button>
          </div>
          <h2 className={lb.name}>{p.guestName}</h2>
          <div className={styles.tags}>
            <span className={styles.tag}>{photoKind(p) === "moment" ? "Momen" : "Photobooth"}</span>
            {p.approval === "PENDING" && <span className={`${styles.tag} ${styles.tagWarn}`}>Menunggu persetujuan</span>}
            {p.hiddenFromWall && <span className={styles.tag}>Tersembunyi di Live Wall</span>}
            {p.hiddenFromGallery && <span className={styles.tag}>Tersembunyi di galeri</span>}
          </div>
          <p className={lb.wish}>&ldquo;{p.wishes}&rdquo;</p>
          <ModActions p={p} ctx={ctx} full />
        </aside>
      </div>
    </div>
  );
}

export function PhotoModeration({ photos, onAction, onDelete, downloadAllHref, onDownloadAll }: ModerationProps) {
  const [zipBusy, setZipBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModFilter>("all");
  const [kind, setKind] = useState<KindFilter>("all");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return photos.filter((p) => {
      if (filter === "pending" && p.approval !== "PENDING") return false;
      if (filter === "hidden" && !p.hiddenFromWall && !p.hiddenFromGallery) return false;
      if (kind !== "all" && photoKind(p) !== kind) return false;
      return !q || p.guestName.toLowerCase().includes(q) || p.wishes.toLowerCase().includes(q);
    });
  }, [photos, query, filter, kind]);

  const run = async (p: Photo, fn: () => Promise<void>) => {
    setBusyId(p.id);
    setError("");
    try {
      await fn();
      setConfirmId(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };
  const ctx: ActionCtx = { busyId, confirmId, setConfirmId, run, onAction, onDelete };
  const closeViewer = useCallback(() => setOpenIndex(null), []);

  return (
    <div className={styles.stack}>
      <div className={styles.modBar}>
        <label className={styles.search}>
          <Search />
          <input className="input" placeholder="Cari nama atau ucapan…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="chips">
          {(
            [
              ["all", "Semua"],
              ["pending", "Perlu persetujuan"],
              ["hidden", "Disembunyikan"],
            ] as [ModFilter, string][]
          ).map(([id, label]) => (
            <button key={id} className={`chip ${filter === id ? "active" : ""}`} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="chips" role="radiogroup" aria-label="Jenis foto">
          {(
            [
              ["all", "Semua jenis"],
              ["photobooth", "Photobooth"],
              ["moment", "Momen"],
            ] as [KindFilter, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              role="radio"
              aria-checked={kind === id}
              className={`chip ${kind === id ? "active" : ""}`}
              onClick={() => setKind(id)}
            >
              {label}
              {id !== "all" && <small className={styles.kindCount}>{photos.filter((p) => photoKind(p) === id).length}</small>}
            </button>
          ))}
        </div>
        <span className="subtle">{list.length} foto</span>
      </div>
      {(downloadAllHref || onDownloadAll) && photos.some((p) => p.status === "READY") && (
        <div className={styles.downloadBar}>
          <span>
            <strong>Untuk penyelenggara:</strong> unduh semua foto tanpa watermark.
          </span>
          {downloadAllHref ? (
            <a className="btn btn-primary btn-sm" href={downloadAllHref} download>
              <Download /> Download semua (ZIP)
            </a>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              disabled={zipBusy}
              onClick={async () => {
                setZipBusy(true);
                setError("");
                try {
                  await onDownloadAll?.();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setZipBusy(false);
                }
              }}
            >
              {zipBusy ? <span className="spinner" /> : <Download />} Download semua (ZIP)
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="alert alert-error">
          <AlertCircle /> {error}
        </div>
      )}
      {list.length === 0 ? (
        <div className="card empty">
          <span className="empty-icon">
            <Images />
          </span>
          <h3>Tidak ada foto</h3>
        </div>
      ) : (
        <div className={styles.modGrid}>
          {list.map((p, i) => {
            const hidden = p.hiddenFromWall || p.hiddenFromGallery;
            return (
              <article key={p.id} className={`card ${styles.modCard} ${hidden ? styles.dimmed : ""}`}>
                {p.thumbUrl ? (
                  <button className={styles.modThumb} onClick={() => setOpenIndex(i)} aria-label={`Buka foto dari ${p.guestName}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photoSrc(p.thumbUrl)} alt={`Foto dari ${p.guestName}`} loading="lazy" decoding="async" />
                    <span className={styles.zoomHint}>
                      <Maximize2 />
                    </span>
                  </button>
                ) : (
                  <div className={styles.processing}>
                    <span className="spinner" /> Diproses…
                  </div>
                )}
                <div className={styles.modBody}>
                  <div className={styles.modMeta}>
                    <strong>{p.guestName}</strong>
                    <small>{timeAgo(p.createdAt)}</small>
                  </div>
                  {p.approval === "PENDING" && (
                    <div className={styles.tags}>
                      <span className={`${styles.tag} ${styles.tagWarn}`}>Menunggu persetujuan</span>
                    </div>
                  )}
                  <p>{p.wishes}</p>
                  <ModActions p={p} ctx={ctx} />
                </div>
              </article>
            );
          })}
        </div>
      )}
      {openIndex !== null && <ModViewer list={list} index={openIndex} onIndex={setOpenIndex} onClose={closeViewer} ctx={ctx} />}
    </div>
  );
}

/* ---------- Printable check-in QR ---------- */

const fmtWindow = (iso: string) =>
  new Date(iso).toLocaleString("id-ID", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Fetches the (fixed) check-in QR and re-polls so a rotated QR shows up without a reload. */
export function useLiveQr(fetchQr: (() => Promise<QrInfo>) | null) {
  const [qr, setQr] = useState<QrInfo | null>(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!fetchQr) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await fetchQr();
        if (!alive) return;
        setQr(next);
        setError("");
        timer = setTimeout(tick, Math.max(30000, next.refreshAfterMs));
      } catch (err) {
        if (!alive) return;
        setQr(null);
        setError((err as Error).message);
        timer = setTimeout(tick, 60000);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [fetchQr, nonce]);

  return { qr, error, reload: () => setNonce((n) => n + 1) };
}

export function LiveQrPanel({
  fetchQr,
  onRotate,
  footer,
}: {
  fetchQr: () => Promise<QrInfo>;
  onRotate?: () => Promise<unknown>;
  footer?: React.ReactNode;
}) {
  const { qr, error, reload } = useLiveQr(fetchQr);
  const [png, setPng] = useState("");
  const [busy, setBusy] = useState(false);

  const rotate = async () => {
    if (!onRotate) return;
    if (!window.confirm("Ganti QR? Semua QR yang sudah dicetak/dibagikan langsung tidak berlaku dan harus dicetak ulang.")) return;
    setBusy(true);
    try {
      await onRotate();
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`card card-pad ${styles.qrCard}`}>
      <span className="eyebrow">QR check-in photobooth</span>
      <div className={styles.qrBox}>
        {qr ? (
          <QRCode value={qr.url} size={220} onReady={setPng} />
        ) : (
          <div style={{ width: 220, height: 220, display: "grid", placeItems: "center", textAlign: "center" }}>
            {error ? <span className="muted">{error}</span> : <span className="spinner" />}
          </div>
        )}
      </div>
      <p className="muted">
        QR ini tetap (tidak berganti) — boleh dicetak. Hanya berfungsi saat acara aktif dan pada jam acara; tiap perangkat
        maksimal 5 foto. Kalau QR tersebar ke orang luar, buat QR baru — QR lama langsung tidak berlaku.
      </p>
      {qr && (
        <p className="hint">
          {qr.boothOpen ? "Photobooth sedang terbuka · " : "Photobooth belum/tidak terbuka · "}
          berfungsi {fmtWindow(qr.opensAt)} – {fmtWindow(qr.closesAt)}
        </p>
      )}
      <a className={`btn btn-secondary btn-block ${!png ? "disabled" : ""}`} href={png || undefined} download="qr-photobooth.png">
        <Download /> Unduh QR (PNG untuk dicetak)
      </a>
      {onRotate && (
        <button className="btn btn-ghost btn-block" onClick={rotate} disabled={busy}>
          <RefreshCw /> Ganti QR (QR cetakan lama mati)
        </button>
      )}
      {footer}
    </div>
  );
}

/* ---------- Copy row ---------- */

export function CopyRow({ label, url, hint }: { label: string; url: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className={styles.copyRow}>
        <code>{url || "…"}</code>
        <button className="btn btn-sm btn-secondary" onClick={copy} disabled={!url}>
          {copied ? <CheckCircle2 /> : <Copy />} {copied ? "Tersalin" : "Salin"}
        </button>
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/* ---------- helpers ---------- */

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draf",
  ACTIVE: "Aktif",
  PAUSED: "Dijeda",
  ENDED: "Selesai",
};

/** ISO → value for <input type="datetime-local"> in the browser's timezone. */
export function toLocalInput(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string) {
  return v ? new Date(v).toISOString() : "";
}
