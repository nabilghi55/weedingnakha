"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  History,
  ImagePlus,
  Images,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  Plus,
  Settings2,
  Share2,
  Star,
  Trash2,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import { CopyRow, fromLocalInput, LiveQrPanel, PhotoModeration, STATUS_LABEL, StatsGrid, toLocalInput } from "@/components/EventPanels";
import {
  api,
  ApiError,
  downloadAdminZip,
  eventFrames,
  MAX_FRAMES,
  QUOTA_CHOICES,
  UNLIMITED,
  photoSrc,
  setAdminKey,
  type AdminEvent,
  type AuditEntry,
  type EventInput,
  type EventStats,
  type EventStatus,
  type EventType,
  type GalleryVisibility,
  type ModerationMode,
  type Photo,
} from "@/lib/api";
import { THEMES } from "@/lib/filters";
import { canvasToBlob, preparePhoto, readFileAsDataUrl } from "@/lib/image";
import { COVER_STYLES, coverCanvas, type CoverStyle } from "@/lib/coverart";
import { useOrigin } from "@/lib/useOrigin";
import styles from "./admin.module.css";
import { EVENT_TYPES, eventName, eventTypeName, isWedding } from "@/lib/format";

type Tab = "overview" | "moderation" | "settings" | "access" | "audit";

/**
 * The console is only reachable at its secret URL (/<ADMIN_PATH>/, see
 * ADMIN_PATH in backend/.env). The key is the first path segment; the API
 * answers 404 to a wrong key, and then this page looks like any missing page.
 */
function adminKeyFromLocation() {
  const seg = window.location.pathname.split("/").filter(Boolean)[0] ?? "";
  return /^[A-Za-z0-9_-]{16,64}$/.test(seg) ? seg : "";
}

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null | "hidden">(null);

  useEffect(() => {
    const key = adminKeyFromLocation();
    if (!key) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads window.location, unavailable during render
      setAuthed("hidden");
      return;
    }
    setAdminKey(key);
    api.admin
      .me()
      .then(() => setAuthed(true))
      .catch((e) => setAuthed(e instanceof ApiError && e.status === 404 ? "hidden" : false));
  }, []);

  if (authed === "hidden") return <NotFound />;
  if (authed === null) {
    return (
      <div className="page">
        <div className="container" style={{ display: "grid", placeItems: "center", minHeight: "50vh" }}>
          <span className="spinner" />
        </div>
      </div>
    );
  }
  return authed ? <Dashboard onLogout={() => setAuthed(false)} /> : <Login onLogin={() => setAuthed(true)} />;
}

function NotFound() {
  return (
    <div className="page">
      <div className="container" style={{ display: "grid", placeItems: "center", minHeight: "50vh", textAlign: "center" }}>
        <div>
          <h1 style={{ fontSize: "2rem", marginBottom: 8 }}>404</h1>
          <p style={{ opacity: 0.7 }}>Halaman tidak ditemukan.</p>
        </div>
      </div>
    </div>
  );
}

/* ================= Login ================= */

function Login({ onLogin }: { onLogin: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.admin.login(pin); // sets an HttpOnly session cookie
      onLogin();
    } catch (err) {
      setError((err as Error).message);
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className={styles.loginWrap}>
        <form onSubmit={submit} className={`card card-feature card-pad ${styles.login} fade-up`}>
          <span className={styles.lockIcon}>
            <Lock />
          </span>
          <h1>Panel Admin</h1>
          <p className="muted">Masukkan PIN untuk mengelola acara, akses tuan rumah, dan moderasi foto.</p>
          <input
            className={`input ${styles.pin}`}
            type="password"
            autoComplete="current-password"
            placeholder="••••••"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoFocus
            aria-label="PIN admin"
          />
          {error && (
            <div className="alert alert-error" role="alert">
              <AlertCircle /> {error}
            </div>
          )}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !pin}>
            {busy ? <span className="spinner" /> : "Masuk"}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ================= Dashboard ================= */

interface Reveal {
  eventId: string;
  url: string;
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const { setEvent } = useApp();
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [reveal, setReveal] = useState<Reveal | null>(null);

  const handleAuthError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onLogout();
    },
    [onLogout],
  );

  const loadEvents = useCallback(async () => {
    try {
      const list = await api.admin.events();
      setEvents(list);
      setSelectedId((cur) => cur ?? list.find((e) => e.isDefault)?.id ?? list[0]?.id ?? null);
      if (list.length === 0) setCreating(true);
    } catch (err) {
      handleAuthError(err);
    }
  }, [handleAuthError]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    loadEvents();
  }, [loadEvents]);

  const ev = events.find((e) => e.id === selectedId) ?? null;
  useEffect(() => {
    if (ev) setEvent(ev);
  }, [ev, setEvent]);

  const upsert = useCallback((e: AdminEvent) => {
    setEvents((list) => (list.some((x) => x.id === e.id) ? list.map((x) => (x.id === e.id ? e : x)) : [e, ...list]));
  }, []);

  const logout = async () => {
    await api.admin.logout().catch(() => undefined);
    onLogout();
  };

  const TABS: { id: Tab; label: string; icon: typeof Images }[] = [
    { id: "overview", label: "Ringkasan", icon: LayoutDashboard },
    { id: "moderation", label: "Moderasi", icon: Images },
    { id: "settings", label: "Pengaturan", icon: Settings2 },
    { id: "access", label: "Akses & QR", icon: Share2 },
    { id: "audit", label: "Audit", icon: History },
  ];

  return (
    <div className="page">
      <div className="container">
        <header className={styles.head}>
          <div>
            <span className="eyebrow">Admin</span>
            <h1>{ev ? isWedding(ev) ? <>{ev.groomName} <em>&amp;</em> {ev.brideName}</> : ev.title : "Acara"}</h1>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={logout}>
            <LogOut /> Keluar
          </button>
        </header>

        <div className={styles.eventList}>
          {events.map((e) => (
            <button
              key={e.id}
              className={`chip ${e.id === selectedId && !creating ? "active" : ""}`}
              onClick={() => {
                setSelectedId(e.id);
                setCreating(false);
              }}
            >
              {e.isDefault && <Star size={12} />} {eventName(e)} · {eventTypeName(e)} · {STATUS_LABEL[e.status]}
            </button>
          ))}
          <button className={`chip ${creating ? "active" : ""}`} onClick={() => setCreating(true)}>
            <Plus size={14} /> Acara baru
          </button>
        </div>

        {creating ? (
          <CreateEvent
            onError={handleAuthError}
            onCreated={(e, url) => {
              upsert(e);
              setSelectedId(e.id);
              setCreating(false);
              setReveal({ eventId: e.id, url });
              setTab("access");
            }}
          />
        ) : ev ? (
          <>
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
                </button>
              ))}
            </nav>
            {tab === "overview" && <Overview key={ev.id} ev={ev} onError={handleAuthError} />}
            {tab === "moderation" && <Moderation key={ev.id} ev={ev} onError={handleAuthError} />}
            {tab === "settings" && <Settings key={ev.id} ev={ev} onSaved={upsert} onError={handleAuthError} />}
            {tab === "access" && (
              <Access
                key={ev.id}
                ev={ev}
                reveal={reveal?.eventId === ev.id ? reveal.url : ""}
                onReveal={(url) => setReveal({ eventId: ev.id, url })}
                onClearReveal={() => setReveal(null)}
                onSaved={upsert}
                onDefault={loadEvents}
                onError={handleAuthError}
              />
            )}
            {tab === "audit" && <Audit key={ev.id} eventId={ev.id} onError={handleAuthError} />}
          </>
        ) : null}
      </div>
    </div>
  );
}

interface TabProps {
  ev: AdminEvent;
  onError: (err: unknown) => void;
}

/* ---------- Overview ---------- */

function Overview({ ev, onError }: TabProps) {
  const [stats, setStats] = useState<EventStats | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.admin
        .stats(ev.id)
        .then((s) => alive && setStats(s))
        .catch(onError);
    load();
    const id = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [ev.id, onError]);

  return (
    <div className={styles.stack}>
      <div className="card card-pad">
        <div className={styles.sectionHead}>
          <h2>Status photobooth</h2>
          <span className={`badge ${ev.booth.open ? "badge-live" : ""}`}>
            {ev.booth.open && <span className="live-dot" />} {ev.booth.open ? "Terbuka" : STATUS_LABEL[ev.status]}
          </span>
        </div>
        <p className="muted">{ev.booth.open ? "Tamu dapat check-in lewat QR (QR tetap, boleh dicetak)." : ev.booth.message}</p>
      </div>
      <StatsGrid stats={stats} />
    </div>
  );
}

/* ---------- Moderation ---------- */

function Moderation({ ev, onError }: TabProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.admin
        .photos(ev.id)
        .then((r) => alive && setPhotos(r.photos))
        .catch(onError);
    load();
    const id = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [ev.id, onError]);

  return (
    <PhotoModeration
      photos={photos}
      onDownloadAll={async () => {
        const blob = await downloadAdminZip(ev.id);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `seribu-lensa-${ev.slug}.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }}
      onAction={async (p, action, target) => {
        try {
          const updated = await api.admin.moderate(ev.id, p.id, action, target);
          setPhotos((list) => list.map((x) => (x.id === p.id ? updated : x)));
        } catch (err) {
          onError(err);
          throw err;
        }
      }}
      onDelete={async (p) => {
        try {
          await api.admin.deletePhoto(ev.id, p.id);
          setPhotos((list) => list.filter((x) => x.id !== p.id));
        } catch (err) {
          onError(err);
          throw err;
        }
      }}
    />
  );
}

/* ---------- Event form (create + settings) ---------- */

interface FormState {
  slug: string;
  status: EventStatus;
  type: EventType;
  title: string;
  groomName: string;
  brideName: string;
  groomParent: string;
  brideParent: string;
  venue: string;
  venueAddress: string;
  mapsUrl: string;
  hashtag: string;
  defaultWishes: string;
  photoLimit: number;
  momentLimit: number;
  theme: AdminEvent["theme"];
  start: string; // datetime-local
  end: string;
  lat: string;
  lng: string;
  radiusMeters: number;
  moderationMode: ModerationMode;
  galleryVisibility: GalleryVisibility;
}

function formFrom(ev?: AdminEvent): FormState {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const startIso = ev?.startAt ?? new Date(now.getTime() + 7 * 864e5).toISOString();
  const endIso = ev?.endAt ?? new Date(Date.parse(startIso) + 4 * 36e5).toISOString();
  return {
    slug: ev?.slug ?? "",
    status: ev?.status ?? "DRAFT",
    type: ev?.type ?? "wedding",
    title: ev?.title ?? "",
    groomName: ev?.groomName ?? "",
    brideName: ev?.brideName ?? "",
    groomParent: ev?.groomParent ?? "",
    brideParent: ev?.brideParent ?? "",
    venue: ev?.venue ?? "",
    venueAddress: ev?.venueAddress ?? "",
    mapsUrl: ev?.mapsUrl ?? "",
    hashtag: ev?.hashtag ?? "",
    defaultWishes: ev?.customWishes ?? "",
    photoLimit: ev?.maxPhotosPerGuest ?? 5,
    momentLimit: ev?.maxMomentsPerGuest ?? 10,
    theme: ev?.theme ?? "maroon",
    start: toLocalInput(startIso),
    end: toLocalInput(endIso),
    lat: ev?.venueLatitude != null ? String(ev.venueLatitude) : "",
    lng: ev?.venueLongitude != null ? String(ev.venueLongitude) : "",
    radiusMeters: ev?.radiusMeters ?? 150,
    moderationMode: ev?.moderationMode ?? "AUTO_PUBLISH",
    galleryVisibility: ev?.galleryVisibility ?? "GUESTS",
  };
}

function toInput(f: FormState): EventInput {
  const hasLoc = f.lat.trim() !== "" && f.lng.trim() !== "";
  return {
    slug: f.slug.trim() || undefined,
    status: f.status,
    type: f.type,
    title: f.title,
    groomName: f.groomName,
    brideName: f.brideName,
    groomParent: f.groomParent,
    brideParent: f.brideParent,
    venue: f.venue,
    venueAddress: f.venueAddress,
    mapsUrl: f.mapsUrl,
    hashtag: f.hashtag,
    defaultWishes: f.defaultWishes,
    photoLimit: f.photoLimit,
    momentLimit: f.momentLimit,
    theme: f.theme,
    startAt: fromLocalInput(f.start),
    endAt: fromLocalInput(f.end),
    venueLatitude: hasLoc ? Number(f.lat) : undefined,
    venueLongitude: hasLoc ? Number(f.lng) : undefined,
    radiusMeters: f.radiusMeters,
    moderationMode: f.moderationMode,
    galleryVisibility: f.galleryVisibility,
  };
}

function EventFields({ form, set, full }: { form: FormState; set: <K extends keyof FormState>(k: K, v: FormState[K]) => void; full: boolean }) {
  const text = (k: keyof FormState, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="field">
      <label className="label" htmlFor={`f-${k}`}>
        {label}
      </label>
      <input id={`f-${k}`} className="input" value={form[k] as string} onChange={(e) => set(k, e.target.value as never)} {...props} />
    </div>
  );

  return (
    <>
      <h2>Jenis acara</h2>
      <div className="chips" role="radiogroup" aria-label="Jenis acara">
        {EVENT_TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={form.type === t.id}
            className={`chip ${form.type === t.id ? "active" : ""}`}
            onClick={() => set("type", t.id)}
          >
            {t.name}
          </button>
        ))}
      </div>
      <p className="hint">{EVENT_TYPES.find((t) => t.id === form.type)?.desc}</p>

      {form.type === "wedding" ? (
        <>
          <h2 style={{ marginTop: 8 }}>Mempelai</h2>
          <div className={styles.formGrid}>
            {text("groomName", "Nama mempelai pria", { required: true, maxLength: 40 })}
            {text("brideName", "Nama mempelai wanita", { required: true, maxLength: 40 })}
            {full && text("groomParent", "Keterangan orang tua (pria)", { placeholder: "Putra dari Bpk. … & Ibu …" })}
            {full && text("brideParent", "Keterangan orang tua (wanita)", { placeholder: "Putri dari Bpk. … & Ibu …" })}
          </div>
        </>
      ) : (
        <>
          <h2 style={{ marginTop: 8 }}>Nama acara</h2>
          <div className={styles.formGrid}>
            {text("title", "Nama acara", {
              required: true,
              maxLength: 80,
              placeholder: form.type === "campus" ? "cth. Wisuda FEB UB 2026" : "cth. Annual Gathering PT Nakha 2026",
            })}
          </div>
        </>
      )}

      <h2 style={{ marginTop: 8 }}>Jadwal</h2>
      <div className={styles.formGrid}>
        {text("start", "Mulai", { type: "datetime-local", required: true })}
        {text("end", "Selesai", { type: "datetime-local", required: true })}
      </div>
      <p className="hint">Photobooth dibuka 60 menit sebelum mulai dan ditutup 60 menit setelah selesai (waktu sesuai perangkat ini).</p>


      {full && (
        <>
          <h2 style={{ marginTop: 8 }}>Detail undangan</h2>
          <div className={styles.formGrid}>
            {text("venue", "Nama tempat", { placeholder: "cth. The Glow Ballroom" })}
            {text("venueAddress", "Alamat")}
            {text("mapsUrl", "Link Google Maps", { type: "url", placeholder: "https://maps.app.goo.gl/…" })}
            {text("hashtag", "Hashtag", { placeholder: form.type === "wedding" ? "#RianSalsaSelamanya" : "#WisudaFEB2026" })}
            {text("defaultWishes", "Ucapan bawaan", {
              placeholder: form.type === "wedding" ? "Selamat menempuh hidup baru!" : "cth. PEKAN ELEKTRO GOKIL!",
              maxLength: 120,
              title: "Dipakai kalau tamu tidak menulis ucapan",
            })}
            {text("slug", "Slug link acara", { placeholder: "rian-salsa", pattern: "[a-z0-9-]+" })}
          </div>
        </>
      )}
    </>
  );
}

function CreateEvent({ onCreated, onError }: { onCreated: (e: AdminEvent, hostUrl: string) => void; onError: (e: unknown) => void }) {
  const [form, setForm] = useState<FormState>(() => formFrom());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api.admin.createEvent(toInput(form));
      onCreated(res.event, res.hostAccessUrl);
    } catch (err) {
      onError(err);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className={`card card-pad ${styles.stack}`}>
      <EventFields form={form} set={set} full={false} />
      <p className="hint">
        Acara baru dibuat sebagai <strong>Draf</strong>. Host token dibuat otomatis dan hanya ditampilkan sekali setelah ini.
      </p>
      {error && (
        <div className="alert alert-error">
          <AlertCircle /> {error}
        </div>
      )}
      <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
        {busy ? <span className="spinner" /> : "Buat Acara"}
      </button>
    </form>
  );
}

function Settings({ ev, onSaved, onError }: TabProps & { onSaved: (e: AdminEvent) => void }) {
  const [form, setForm] = useState<FormState>(() => formFrom(ev));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const saved = await api.admin.updateEvent(ev.id, toInput(form));
      onSaved(saved);
      setForm(formFrom(saved));
      setMsg({ ok: true, text: "Pengaturan tersimpan dan langsung tampil di semua perangkat." });
    } catch (err) {
      onError(err);
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className={styles.settings}>
      <div className={styles.stack}>
        <CoverPhoto ev={ev} onSaved={onSaved} onError={onError} />
        <CustomFrame ev={ev} onSaved={onSaved} onError={onError} />
        <div className={`card card-pad ${styles.stack}`}>
          <EventFields form={form} set={set} full />
        </div>
      </div>

      <div className={`card card-pad ${styles.stack}`}>
        <h2>Status acara</h2>
        <div className="chips">
          {(["DRAFT", "ACTIVE", "PAUSED", "ENDED"] as EventStatus[]).map((s) => (
            <button type="button" key={s} className={`chip ${form.status === s ? "active" : ""}`} onClick={() => set("status", s)}>
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <p className="hint">Photobooth hanya menerima tamu yang scan QR acara, saat status Aktif dan di jam acara.</p>

        <h2 style={{ marginTop: 8 }}>Moderasi &amp; galeri</h2>
        <div className="chips">
          {(
            [
              ["AUTO_PUBLISH", "Otomatis tampil"],
              ["MANUAL_APPROVAL", "Perlu persetujuan"],
            ] as [ModerationMode, string][]
          ).map(([id, label]) => (
            <button type="button" key={id} className={`chip ${form.moderationMode === id ? "active" : ""}`} onClick={() => set("moderationMode", id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="chips">
          {(
            [
              ["GUESTS", "Galeri: tamu check-in"],
              ["PUBLIC", "Galeri: publik"],
              ["PRIVATE", "Galeri: hanya host"],
            ] as [GalleryVisibility, string][]
          ).map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={`chip ${form.galleryVisibility === id ? "active" : ""}`}
              onClick={() => set("galleryVisibility", id)}
            >
              {label}
            </button>
          ))}
        </div>

        <h2 style={{ marginTop: 8 }}>Batas per perangkat</h2>
        {(
          [
            ["photoLimit", "Kolase photobooth"],
            ["momentLimit", "Foto momen"],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="field">
            <span className="label">{label}</span>
            <div className="chips" role="radiogroup" aria-label={`Batas ${label.toLowerCase()} per perangkat`}>
              {QUOTA_CHOICES.map((n) => (
                <button
                  type="button"
                  key={n}
                  role="radio"
                  aria-checked={form[key] === n}
                  className={`chip ${form[key] === n ? "active" : ""}`}
                  onClick={() => set(key, n)}
                >
                  {n === UNLIMITED ? "Tanpa batas" : n}
                </button>
              ))}
            </div>
          </div>
        ))}
        <p className="hint">Berapa kali satu HP tamu boleh mengirim. Perubahan langsung berlaku, termasuk untuk tamu yang sudah check-in.</p>

        <h2 style={{ marginTop: 8 }}>Tema warna</h2>
        <div className={styles.themes}>
          {THEMES.map((t) => (
            <button
              type="button"
              key={t.id}
              className={`${styles.theme} ${form.theme === t.id ? styles.themeActive : ""}`}
              onClick={() => set("theme", t.id)}
              aria-pressed={form.theme === t.id}
              style={{ "--c": t.color } as React.CSSProperties}
            >
              <span className={styles.themeSwatch} />
              <strong>{t.name}</strong>
              <small>{t.desc}</small>
            </button>
          ))}
        </div>

        {msg && (
          <div className={`alert ${msg.ok ? "alert-success" : "alert-error"}`} role="status">
            {msg.ok ? <CheckCircle2 /> : <AlertCircle />} {msg.text}
          </div>
        )}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? <span className="spinner" /> : "Simpan Pengaturan"}
        </button>
      </div>
    </form>
  );
}

/* ---------- Custom photobooth frame ---------- */

function CustomFrame({ ev, onSaved, onError }: TabProps & { onSaved: (e: AdminEvent) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const frames = eventFrames(ev);
  const full = frames.length >= MAX_FRAMES;

  const run = async (fn: () => Promise<AdminEvent>) => {
    setBusy(true);
    setError("");
    try {
      onSaved(await fn());
    } catch (err) {
      onError(err);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.type !== "image/png") {
      setError("Bingkai harus berupa file PNG.");
      return;
    }
    void run(() => api.admin.uploadFrame(ev.id, file));
  };

  return (
    <div className={`card card-pad ${styles.stack}`}>
      <div>
        <h2>Bingkai photobooth</h2>
        <p className="hint" style={{ marginTop: 4 }}>
          Upload sampai {MAX_FRAMES} bingkai khusus acara ini ({frames.length}/{MAX_FRAMES} terpakai). Kalau lebih dari satu, tamu memilih
          bingkainya sebelum mulai foto.
        </p>
      </div>
      {frames.length ? (
        <div className={styles.frameGrid}>
          {frames.map((f, i) => (
            <div key={f.id} className={styles.frameItem}>
              <div className={styles.frameBox}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoSrc(f.url)} alt={`Bingkai ${i + 1}`} />
              </div>
              <div className={styles.row}>
                <strong className={styles.frameName}>Bingkai {i + 1}</strong>
                {f.id !== "legacy" && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => run(() => api.admin.deleteFrame(ev.id, f.id))}
                    disabled={busy}
                  >
                    <Trash2 /> Hapus
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.frameBox}>
          <div className={styles.coverEmpty}>
            <ImagePlus />
            <span>Belum ada bingkai khusus</span>
          </div>
        </div>
      )}
      <ul className={styles.frameRules}>
        <li>
          File <strong>PNG</strong>. Area foto tamu boleh <strong>transparan</strong> (bolong) atau diisi <strong>hijau</strong>{" "}
          (greenscreen), jadi desain Canva bisa langsung di-export tanpa dikosongkan.
        </li>
        <li>Kalau pakai hijau, jangan pakai warna hijau di bagian lain desain, karena ikut jadi area foto.</li>
        <li>Ukuran Instagram Story: 1080 × 1920 px (9:16). Rasio lain tetap bisa, ditaruh di tengah hasil 9:16.</li>
        <li>Setiap kotak foto jadi satu pose: 2 kotak = 2 pose, 3 kotak = 3 pose.</li>
      </ul>
      {error && (
        <div className="alert alert-error">
          <AlertCircle /> {error}
        </div>
      )}
      <div className={styles.row}>
        <button type="button" className="btn btn-dark btn-sm" onClick={() => fileRef.current?.click()} disabled={busy || full}>
          {busy ? <span className="spinner" /> : <ImagePlus />} {full ? `Maksimal ${MAX_FRAMES} bingkai` : "Tambah bingkai"}
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/png" hidden onChange={onFile} />
    </div>
  );
}

/* ---------- Cover photo ---------- */

function CoverPhoto({ ev, onSaved, onError }: TabProps & { onSaved: (e: AdminEvent) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const upload = async (blob: Blob) => {
    setBusy(true);
    setError("");
    try {
      onSaved(await api.admin.uploadCover(ev.id, blob));
    } catch (err) {
      onError(err);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      await upload(await preparePhoto(await readFileAsDataUrl(file), "none", 2200));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const accent = THEMES.find((t) => t.id === ev.theme)?.color ?? THEMES[0].color;
  const [previews, setPreviews] = useState<Record<string, string>>({});
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const st of COVER_STYLES) next[st.id] = coverCanvas(st.id, accent, 480, 320).toDataURL("image/jpeg", 0.8);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- canvas previews are browser-only
    setPreviews(next);
  }, [accent]);

  const applyDesign = async (style: CoverStyle) => upload(await canvasToBlob(coverCanvas(style, accent), "image/jpeg", 0.9));

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      onSaved(await api.admin.deleteCover(ev.id));
    } catch (err) {
      onError(err);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`card card-pad ${styles.stack}`}>
      <div>
        <h2>Foto sampul</h2>
        <p className="hint" style={{ marginTop: 4 }}>
          Foto asli (mempelai, kampus, atau tim) untuk latar sampul. Tanpa foto, undangan tampil dengan desain tipografi.
        </p>
      </div>
      <div className={styles.cover}>
        {ev.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoSrc(ev.coverUrl)} alt="Foto sampul" />
        ) : (
          <div className={styles.coverEmpty}>
            <ImagePlus />
            <span>Belum ada foto sampul</span>
          </div>
        )}
      </div>
      {error && (
        <div className="alert alert-error">
          <AlertCircle /> {error}
        </div>
      )}
      <div className={styles.row}>
        <button type="button" className="btn btn-dark btn-sm" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? <span className="spinner" /> : <ImagePlus />} {ev.coverUrl ? "Ganti foto" : "Upload foto"}
        </button>
        {ev.coverUrl && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={remove} disabled={busy}>
            <Trash2 /> Hapus
          </button>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png" hidden onChange={onFile} />

      <hr className="divider" />
      <div>
        <h3 className={styles.subhead}>Belum ada foto? Pakai sampul desain</h3>
        <p className="hint" style={{ marginTop: 4 }}>
          Artwork mengikuti warna tema saat ini. Kalau tema diganti, klik lagi desainnya agar warnanya ikut berubah.
        </p>
      </div>
      <div className={styles.designs}>
        {COVER_STYLES.map((st) => (
          <button type="button" key={st.id} className={styles.design} onClick={() => applyDesign(st.id)} disabled={busy}>
            {previews[st.id] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previews[st.id]} alt="" />
            ) : (
              <span className={styles.designPh} />
            )}
            <span className={styles.designLabel}>
              {st.name}
              <small>Pakai</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- Access: host token, Live Wall link, QR ---------- */

function Access({
  ev,
  reveal,
  onReveal,
  onClearReveal,
  onSaved,
  onDefault,
  onError,
}: TabProps & {
  reveal: string;
  onReveal: (url: string) => void;
  onClearReveal: () => void;
  onSaved: (e: AdminEvent) => void;
  onDefault: () => void;
}) {
  const origin = useOrigin();
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [error, setError] = useState("");
  const [wallUrl, setWallUrl] = useState("");
  const fetchQr = useCallback(() => api.admin.qr(ev.id), [ev.id]);
  const rotateQr = useCallback(() => api.admin.rotateQr(ev.id), [ev.id]);

  useEffect(() => {
    api.admin
      .displayLink(ev.id)
      .then((r) => setWallUrl(r.url))
      .catch(onError);
  }, [ev.id, onError]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      onError(err);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const regenerate = () =>
    run(async () => {
      const res = await api.admin.regenerateHostToken(ev.id);
      onSaved(res.event);
      onReveal(res.hostAccessUrl);
    });

  const revoke = () =>
    run(async () => {
      onSaved(await api.admin.revokeHostToken(ev.id));
      onClearReveal();
      setConfirmRevoke(false);
    });

  const inviteUrl = origin ? `${origin}/?e=${encodeURIComponent(ev.slug)}` : "";

  return (
    <div className={styles.share}>
      <div className={`card card-pad ${styles.stack}`}>
        <h2>
          <KeyRound size={18} /> Akses tuan rumah
        </h2>
        <p className="muted">
          {ev.hostTokenActive
            ? `Host token aktif sejak ${ev.hostTokenIssuedAt ? new Date(ev.hostTokenIssuedAt).toLocaleString("id-ID") : "-"}.`
            : "Tidak ada host token aktif — tuan rumah tidak dapat membuka dashboard."}
        </p>
        {reveal && (
          <div className={styles.tokenBox} role="status">
            <strong>Salin sekarang — link ini hanya ditampilkan sekali.</strong>
            <CopyRow label="Link akses tuan rumah" url={reveal} hint="Kirim langsung ke tuan rumah (WhatsApp pribadi). Server hanya menyimpan hash-nya." />
            <button className="btn btn-sm btn-ghost" onClick={onClearReveal}>
              Sudah saya salin
            </button>
          </div>
        )}
        {error && (
          <div className="alert alert-error">
            <AlertCircle /> {error}
          </div>
        )}
        <div className={styles.row}>
          <button className="btn btn-secondary btn-sm" onClick={regenerate} disabled={busy}>
            <KeyRound /> {ev.hostTokenActive ? "Buat ulang host token" : "Buat host token"}
          </button>
          {ev.hostTokenActive &&
            (confirmRevoke ? (
              <span className={styles.confirm}>
                <span>Cabut akses?</span>
                <button className="btn btn-sm btn-ghost" onClick={() => setConfirmRevoke(false)}>
                  Batal
                </button>
                <button className="btn btn-sm btn-danger" onClick={revoke} disabled={busy}>
                  Cabut
                </button>
              </span>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRevoke(true)}>
                Cabut akses
              </button>
            ))}
        </div>
        <p className="hint">Membuat ulang atau mencabut token langsung mengakhiri semua sesi tuan rumah yang sedang login.</p>

        <hr className="divider" />
        <CopyRow label="Link undangan" url={inviteUrl} />
        <CopyRow label="Link Live Wall (layar acara, read-only)" url={wallUrl} />
        <div className={styles.row}>
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => run(async () => setWallUrl((await api.admin.rotateDisplayLink(ev.id)).url))}
          >
            Ganti link Live Wall
          </button>
          {!ev.isDefault && (
            <button
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.admin.setDefault(ev.id);
                  onDefault();
                })
              }
            >
              <Star /> Jadikan acara utama (halaman /)
            </button>
          )}
        </div>
      </div>
      <LiveQrPanel fetchQr={fetchQr} onRotate={rotateQr} />
    </div>
  );
}

/* ---------- Audit ---------- */

function Audit({ eventId, onError }: { eventId: string; onError: (e: unknown) => void }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    api.admin
      .audit(eventId)
      .then(setEntries)
      .catch((err) => {
        onError(err);
        setEntries([]);
      });
  }, [eventId, onError]);

  if (!entries) return <span className="spinner" />;
  return (
    <div className="card card-pad">
      <h2>Audit log</h2>
      {entries.length === 0 ? (
        <p className="muted">Belum ada aktivitas.</p>
      ) : (
        <ul className={styles.audit} style={{ listStyle: "none", padding: 0, marginTop: 12 }}>
          {entries.map((e) => (
            <li key={e.id}>
              <code>{e.action}</code>
              <span className="subtle">
                {e.actorType}
                {e.targetId && e.targetId !== e.eventId ? ` → ${e.targetId}` : ""}
              </span>
              {e.metadata && (
                <span className="subtle">
                  {Object.entries(e.metadata)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(" · ")}
                </span>
              )}
              <span className="subtle" style={{ marginLeft: "auto" }}>
                {new Date(e.createdAt).toLocaleString("id-ID")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
