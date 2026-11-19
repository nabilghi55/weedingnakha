"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Images,
  LayoutDashboard,
  Lock,
  LogOut,
  MonitorPlay,
  Pause,
  Play,
  QrCode,
  RefreshCw,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import { CopyRow, LiveQrPanel, PhotoModeration, STATUS_LABEL, StatsGrid } from "@/components/EventPanels";
import {
  api,
  ApiError,
  openStream,
  photoSrc,
  type EventStats,
  type GalleryVisibility,
  type ModerationMode,
  type Photo,
  type PrivateEvent,
} from "@/lib/api";
import styles from "../admin/admin.module.css";
import { isWedding } from "@/lib/format";

type Tab = "overview" | "photos" | "screen" | "settings";

const ACCESS_ERRORS: Record<string, string> = {
  invalid: "Link akses tidak valid, sudah dicabut, atau sudah diganti. Minta link baru ke admin.",
  rate: "Terlalu banyak percobaan. Tunggu satu menit lalu buka kembali link akses.",
  server: "Server sedang bermasalah. Coba lagi sebentar.",
};

/**
 * Customer (host) dashboard. Access only through /host/access?token=… which
 * the backend exchanges for an HttpOnly session cookie before redirecting
 * here; every call below is scoped server-side to the host's own event.
 */
export default function HostPage() {
  const { setEvent } = useApp();
  const [ev, setEv] = useState<PrivateEvent | null>(null);
  const [state, setState] = useState<"checking" | "ok" | "denied">("checking");
  const [accessError, setAccessError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    if (err) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of the redirect reason
      setAccessError(ACCESS_ERRORS[err] ?? ACCESS_ERRORS.invalid);
      window.history.replaceState(null, "", window.location.pathname);
    }
    api.host
      .me()
      .then((e) => {
        setEv(e);
        setEvent(e);
        setState("ok");
      })
      .catch(() => setState("denied"));
  }, [setEvent]);

  if (state === "checking") {
    return (
      <div className="page">
        <div className="container" style={{ display: "grid", placeItems: "center", minHeight: "50vh" }}>
          <span className="spinner" />
        </div>
      </div>
    );
  }

  if (state === "denied" || !ev) {
    return (
      <div className="page">
        <div className={styles.loginWrap}>
          <div className={`card card-feature card-pad ${styles.login} fade-up`}>
            <span className={styles.lockIcon}>
              <Lock />
            </span>
            <h1>Dashboard Tuan Rumah</h1>
            <p className="muted">
              Buka link akses khusus yang diberikan admin. Link itu hanya perlu dibuka sekali per perangkat; setelah itu sesi
              tersimpan aman selama maksimal 24 jam.
            </p>
            {accessError && (
              <div className="alert alert-error" role="alert">
                <AlertCircle /> {accessError}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <HostDashboard
      ev={ev}
      onEvent={(e) => {
        setEv(e);
        setEvent(e);
      }}
      onLoggedOut={() => setState("denied")}
    />
  );
}

function HostDashboard({
  ev,
  onEvent,
  onLoggedOut,
}: {
  ev: PrivateEvent;
  onEvent: (e: PrivateEvent) => void;
  onLoggedOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [stats, setStats] = useState<EventStats | null>(null);

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onLoggedOut();
    },
    [onLoggedOut],
  );

  const reload = useCallback(async () => {
    try {
      const [p, s, e] = await Promise.all([api.host.photos(), api.host.stats(), api.host.me()]);
      setPhotos(p.photos);
      setStats(s);
      onEvent(e);
    } catch (err) {
      handle(err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onEvent identity is not stable
  }, [handle]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    reload();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const es = openStream("host");
    es.onmessage = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(reload, 500);
    };
    const timer = setInterval(reload, 60000); // also renews signed thumbnails
    return () => {
      es.close();
      clearInterval(timer);
      if (debounce) clearTimeout(debounce);
    };
  }, [reload]);

  const logout = async () => {
    await api.host.logout().catch(() => undefined);
    onLoggedOut();
  };

  const TABS: { id: Tab; label: string; icon: typeof Images }[] = [
    { id: "overview", label: "Ringkasan", icon: LayoutDashboard },
    { id: "photos", label: "Foto", icon: Images },
    { id: "screen", label: "QR & Layar", icon: QrCode },
    { id: "settings", label: "Pengaturan", icon: Settings2 },
  ];

  return (
    <div className="page">
      <div className="container">
        <header className={styles.head}>
          <div>
            <span className="eyebrow">Tuan rumah</span>
            <h1>
              {isWedding(ev) ? (
                <>
                  {ev.groomName} <em>&amp;</em> {ev.brideName}
                </>
              ) : (
                ev.title
              )}
            </h1>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={logout}>
            <LogOut /> Keluar
          </button>
        </header>

        <nav className={styles.tabs} role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`${styles.tab} ${tab === t.id ? styles.tabActive : ""}`}
              onClick={() => setTab(t.id)}
            >
              <t.icon /> {t.label}
              {t.id === "photos" && stats && stats.pendingApproval > 0 && <span className={styles.count}>{stats.pendingApproval}</span>}
            </button>
          ))}
        </nav>

        {tab === "overview" && <Overview ev={ev} stats={stats} onEvent={onEvent} onError={handle} />}
        {tab === "photos" && (
          <PhotoModeration
            photos={photos}
            downloadAllHref={photoSrc("/api/host/photos/download")}
            onAction={async (p, action, target) => {
              try {
                const updated = await api.host.moderate(p.id, action, target);
                setPhotos((list) => list.map((x) => (x.id === p.id ? updated : x)));
              } catch (err) {
                handle(err);
                throw err;
              }
            }}
            onDelete={async (p) => {
              try {
                await api.host.deletePhoto(p.id);
                setPhotos((list) => list.filter((x) => x.id !== p.id));
              } catch (err) {
                handle(err);
                throw err;
              }
            }}
          />
        )}
        {tab === "screen" && <Screen />}
        {tab === "settings" && <HostSettings ev={ev} onEvent={onEvent} onError={handle} />}
      </div>
    </div>
  );
}

/* ---------- Overview ---------- */

function Overview({
  ev,
  stats,
  onEvent,
  onError,
}: {
  ev: PrivateEvent;
  stats: EventStats | null;
  onEvent: (e: PrivateEvent) => void;
  onError: (e: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    setBusy(true);
    setError("");
    try {
      onEvent(ev.status === "PAUSED" ? await api.host.resume() : await api.host.pause());
    } catch (err) {
      onError(err);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className={styles.stack}>
      <div className="card card-pad">
        <div className={styles.sectionHead}>
          <h2>Photobooth</h2>
          <span className={`badge ${ev.booth.open ? "badge-live" : ""}`}>
            {ev.booth.open && <span className="live-dot" />} {ev.booth.open ? "Terbuka" : STATUS_LABEL[ev.status]}
          </span>
        </div>
        <p className="muted">
          {ev.booth.open
            ? `Tamu dapat check-in dan mengirim hingga ${ev.maxPhotosPerGuest} foto per perangkat.`
            : ev.booth.message}
        </p>
        <p className="hint">
          Jendela photobooth: {fmt(ev.booth.opensAt)} – {fmt(ev.booth.closesAt)}
        </p>
        {error && (
          <div className="alert alert-error">
            <AlertCircle /> {error}
          </div>
        )}
        {(ev.status === "ACTIVE" || ev.status === "PAUSED") && (
          <div className={styles.row} style={{ marginTop: 12 }}>
            <button className={`btn ${ev.status === "PAUSED" ? "btn-primary" : "btn-secondary"}`} onClick={toggle} disabled={busy}>
              {busy ? <span className="spinner" /> : ev.status === "PAUSED" ? <Play /> : <Pause />}{" "}
              {ev.status === "PAUSED" ? "Lanjutkan photobooth" : "Jeda photobooth"}
            </button>
          </div>
        )}
      </div>
      <StatsGrid stats={stats} />
    </div>
  );
}

/* ---------- QR + Live Wall link ---------- */

function Screen() {
  const [wallUrl, setWallUrl] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.host
      .displayLink()
      .then((r) => setWallUrl(r.url))
      .catch(() => undefined);
  }, []);

  const rotateWall = async () => {
    setBusy(true);
    try {
      setWallUrl((await api.host.rotateDisplayLink()).url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.share}>
      <div className={`card card-pad ${styles.stack}`}>
        <h2>Layar acara</h2>
        <CopyRow
          label="Link Live Wall (buka di proyektor/TV)"
          url={wallUrl}
          hint="Link khusus tampilan: hanya bisa melihat foto yang sudah tampil. Tidak memberi akses ke dashboard ini."
        />
        <div className={styles.row}>
          <button className="btn btn-ghost btn-sm" onClick={rotateWall} disabled={busy}>
            <RefreshCw /> Ganti link Live Wall
          </button>
        </div>
        <hr className="divider" />
        <p className="muted">
          Tamu membuka photobooth dengan scan QR di samping. QR ini tetap, jadi boleh dicetak (banner, kartu meja). QR hanya
          berfungsi saat acara aktif dan pada jam acara; tiap perangkat maksimal 5 foto. Kalau QR tersebar ke orang luar, buat QR baru — QR lama langsung tidak berlaku.
        </p>
        <Link href="/qr" className="btn btn-primary">
          <Sparkles /> Kartu QR animasi (layar penuh)
        </Link>
        <Link href={wallUrl || "#"} target="_blank" className={`btn btn-secondary ${!wallUrl ? "disabled" : ""}`}>
          <MonitorPlay /> Buka Live Wall
        </Link>
      </div>
      <LiveQrPanel fetchQr={api.host.qr} onRotate={api.host.rotateQr} />
    </div>
  );
}

/* ---------- Settings ---------- */

function HostSettings({ ev, onEvent, onError }: { ev: PrivateEvent; onEvent: (e: PrivateEvent) => void; onError: (e: unknown) => void }) {
  const [mode, setMode] = useState<ModerationMode>(ev.moderationMode);
  const [visibility, setVisibility] = useState<GalleryVisibility>(ev.galleryVisibility);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const updated = await api.host.settings({ moderationMode: mode, galleryVisibility: visibility });
      onEvent(updated);
      setMsg({ ok: true, text: "Pengaturan tersimpan." });
    } catch (err) {
      onError(err);
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.settings}>
      <div className={`card card-pad ${styles.stack}`}>
        <h2>Publikasi foto</h2>
        <div className="chips">
          {(
            [
              ["AUTO_PUBLISH", "Otomatis tampil"],
              ["MANUAL_APPROVAL", "Perlu persetujuan"],
            ] as [ModerationMode, string][]
          ).map(([id, label]) => (
            <button key={id} type="button" className={`chip ${mode === id ? "active" : ""}`} onClick={() => setMode(id)}>
              {label}
            </button>
          ))}
        </div>
        <p className="hint">Dengan “Perlu persetujuan”, foto baru masuk antrean di tab Foto sebelum tampil di galeri & Live Wall.</p>

        <h2 style={{ marginTop: 8 }}>Siapa yang bisa melihat galeri</h2>
        <div className="chips">
          {(
            [
              ["GUESTS", "Tamu yang check-in"],
              ["PUBLIC", "Semua yang punya link"],
              ["PRIVATE", "Hanya tuan rumah"],
            ] as [GalleryVisibility, string][]
          ).map(([id, label]) => (
            <button key={id} type="button" className={`chip ${visibility === id ? "active" : ""}`} onClick={() => setVisibility(id)}>
              {label}
            </button>
          ))}
        </div>

        {msg && (
          <div className={`alert ${msg.ok ? "alert-success" : "alert-error"}`} role="status">
            {msg.ok ? <CheckCircle2 /> : <AlertCircle />} {msg.text}
          </div>
        )}
        <button className="btn btn-primary btn-lg btn-block" onClick={() => save()} disabled={busy}>
          {busy ? <span className="spinner" /> : "Simpan Pengaturan"}
        </button>
      </div>
    </div>
  );
}
