"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Camera, CheckCircle2, Clock, Download, Image as ImageIcon, Images, LayoutGrid, MapPin, MessageSquare, QrCode, RefreshCw, RotateCcw, Send } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { api, ApiError, eventFrames, photoSrc, putFile, type FilterId, type GuestSession, type LocationFix } from "@/lib/api";
import { getDeviceId, getPosition, LocationError, OUTSIDE_AREA_MESSAGE } from "@/lib/guest";
import { FILTER_GROUPS, filtersInGroup } from "@/lib/filters";
import { clearCustomFrame, COLLAGE_POSES, collageAspects, collagePoses, ensureFrameFonts, frameWindows, loadCustomFrame, renderCollage, renderFrame, selectCustomFrame } from "@/lib/frames";
import { canvasToBlob } from "@/lib/image";
import { BRAND } from "@/lib/brand";
import { filterStyle } from "@/components/FilterPicker";
import CameraScreen from "./CameraScreen";
import styles from "./photobooth.module.css";
import { eventName, isWedding, momentCaption } from "@/lib/format";

type Stage = "intro" | "shoot" | "result" | "posted";
type Snapshot = HTMLCanvasElement;
/** Access gate in front of the camera: QR → location → guest session. */
type Access =
  | { kind: "checking" }
  | { kind: "need-qr" }
  | { kind: "locating" }
  | { kind: "blocked"; title: string; message: string; canRetry: boolean }
  | { kind: "ready" };

const LOCATION_REFRESH_MS = 10 * 60 * 1000;

function blockedFor(err: unknown): Access {
  if (err instanceof LocationError) {
    return { kind: "blocked", title: "Lokasi diperlukan", message: `${OUTSIDE_AREA_MESSAGE} ${err.message}`, canRetry: true };
  }
  if (err instanceof ApiError) {
    switch (err.code) {
      case "OUTSIDE_RADIUS":
        return { kind: "blocked", title: "Di luar area acara", message: OUTSIDE_AREA_MESSAGE, canRetry: true };
      case "LOCATION_INACCURATE":
      case "LOCATION_STALE":
      case "LOCATION_REQUIRED":
        return { kind: "blocked", title: "Lokasi belum akurat", message: err.message, canRetry: true };
      case "QR_INVALID":
        return { kind: "blocked", title: "QR tidak berlaku", message: err.message, canRetry: false };
      case "RATE_LIMITED":
        return { kind: "blocked", title: "Tunggu sebentar", message: err.message, canRetry: true };
    }
    return { kind: "blocked", title: "Photobooth belum tersedia", message: err.message, canRetry: err.status === 0 };
  }
  return { kind: "blocked", title: "Terjadi kesalahan", message: (err as Error).message, canRetry: true };
}

type Rendered = { canvas: HTMLCanvasElement; url: string };

const NAME_KEY = "seribulensa.guestName";
function readName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode: the name is just asked again next time */
  }
}

/** Moment photos are portrait 3:4, without a frame. */
const MOMENT_ASPECT = 3 / 4;

export default function PhotoboothPage() {
  const { event, setSlug } = useApp();
  const [access, setAccess] = useState<Access>({ kind: "checking" });
  const [session, setSession] = useState<GuestSession | null>(null);
  const qrRef = useRef<string | null>(null);

  // intro (name) → shoot (4 poses) → result (collage + send) → posted
  const [stage, setStage] = useState<Stage>("intro");
  const [shots, setShots] = useState<Snapshot[]>([]);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [retakeIdx, setRetakeIdx] = useState<number | null>(null);
  // live filter of the camera; each pose keeps the one it was taken with
  const [filter, setFilter] = useState<FilterId>("none");
  const [shotFilters, setShotFilters] = useState<FilterId[]>([]);
  // result screen: which pose the filter chips change (null = every pose)
  const [filterPose, setFilterPose] = useState<number | null>(null);
  const [collage, setCollage] = useState<Rendered | null>(null);

  const [guestName, setGuestName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [wishes, setWishes] = useState("");
  const [showWishes, setShowWishes] = useState(false);
  const [posting, setPosting] = useState<{ pct: number | null } | null>(null);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [error, setError] = useState("");
  // the last send failed because of the location → offer a one-tap re-check
  const [locIssue, setLocIssue] = useState(false);
  const [locating, setLocating] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareMsg, setShareMsg] = useState("");

  // the event's own frames (up to 3): the guest picks one, the first by default
  const frames = eventFrames(event);
  const frameKey = frames.map((f) => f.url).join("|");
  const [frameId, setFrameId] = useState("");
  const activeFrame = frames.find((f) => f.id === frameId) ?? frames[0];
  const activeUrl = activeFrame ? photoSrc(activeFrame.url) : "";
  // photo windows per frame, once its PNG is loaded (shown in the picker)
  const [windows, setWindows] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    for (const url of frameKey ? frameKey.split("|") : []) {
      loadCustomFrame(photoSrc(url)).then((ok) => {
        if (alive && ok) setWindows((w) => ({ ...w, [url]: frameWindows(photoSrc(url)) }));
      });
    }
    return () => {
      alive = false;
    };
  }, [frameKey]);

  // poses per session: one per window of the chosen frame (else the 2×2 collage)
  const [poses, setPoses] = useState(COLLAGE_POSES);
  const [aspects, setAspects] = useState<number[]>(() => Array.from({ length: COLLAGE_POSES }, () => 1));
  useEffect(() => {
    let alive = true;
    if (!activeUrl) {
      clearCustomFrame();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors the event's frame setting
      setPoses(COLLAGE_POSES);
      setAspects(collageAspects());
      return;
    }
    loadCustomFrame(activeUrl).then((ok) => {
      if (!alive) return;
      if (!ok || !selectCustomFrame(activeUrl)) clearCustomFrame();
      setPoses(collagePoses());
      setAspects(collageAspects());
    });
    return () => {
      alive = false;
    };
  }, [activeUrl]);

  // "booth" = framed collage of several poses · "moment" = one plain photo, no frame
  const [mode, setMode] = useState<"booth" | "moment">("booth");
  const roll = mode === "moment" ? 1 : poses;
  const rollAspects = mode === "moment" ? [MOMENT_ASPECT] : aspects;
  /** The image a session produces: the collage, or the plain moment photo. */
  const renderOutput = useCallback(
    (credit: boolean) =>
      mode === "moment"
        ? renderFrame(shots[0], "plain", shotFilters[0] ?? filter, event, { credit })
        : renderCollage(shots, shotFilters, event, { credit }),
    [mode, shots, shotFilters, filter, event],
  );

  // remembered name from an earlier session on this phone
  useEffect(() => {
    const saved = readName();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
    if (saved) setGuestName(saved);
  }, []);

  const adoptSession = useCallback(
    (gs: GuestSession) => {
      setSession(gs);
      if (gs.event.slug) setSlug(gs.event.slug);
      if (!gs.booth.open) {
        setAccess({ kind: "blocked", title: "Photobooth ditutup", message: gs.booth.message ?? "Photobooth sedang tidak aktif.", canRetry: true });
      } else setAccess({ kind: "ready" });
    },
    [setSlug],
  );

  const checkin = useCallback(async () => {
    const qr = qrRef.current;
    if (!qr) return;
    setAccess({ kind: "checking" });
    try {
      let session: GuestSession;
      try {
        // QR only: no GPS wait when the server has location checks switched off
        session = await api.guest.checkin({ qr, deviceId: getDeviceId() });
      } catch (err) {
        if (!(err instanceof ApiError && err.code === "LOCATION_REQUIRED")) throw err;
        setAccess({ kind: "locating" });
        const fix = await getPosition();
        session = await api.guest.checkin({ qr, deviceId: getDeviceId(), ...fix });
      }
      adoptSession(session);
      qrRef.current = null; // single use on this page
    } catch (err) {
      setAccess(blockedFor(err));
    }
  }, [adoptSession]);

  const loadSession = useCallback(async () => {
    setAccess({ kind: "checking" });
    try {
      adoptSession(await api.guest.session());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAccess({ kind: "need-qr" });
      else setAccess(blockedFor(err));
    }
  }, [adoptSession]);

  // On first load: take the QR token from the URL (then remove it from the
  // address bar/history), or resume an existing guest session.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return; // Strict Mode re-runs effects; start the flow once
    startedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const qr = params.get("qr");
    if (qr) {
      qrRef.current = qr;
      params.delete("qr");
      const rest = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off the async check-in / session flow on mount
    void (qr ? checkin() : loadSession());
  }, [checkin, loadSession]);

  // Re-validate the location periodically while the booth is open.
  useEffect(() => {
    if (access.kind !== "ready" || session?.locationRequired === false) return;
    const id = setInterval(async () => {
      try {
        setSession(await api.guest.location(await getPosition()));
      } catch {
        /* surfaced again on the next upload attempt */
      }
    }, LOCATION_REFRESH_MS);
    return () => clearInterval(id);
  }, [access.kind, session?.locationRequired]);

  // Compose the collage whenever the poses or the filter change.
  useEffect(() => {
    if (stage === "intro" || stage === "shoot" || shots.length < roll) return;
    let alive = true;
    ensureFrameFonts().then(() => {
      if (!alive) return;
      const canvas = renderOutput(true);
      setCollage({ canvas, url: canvas.toDataURL("image/jpeg", 0.9) });
    });
    return () => {
      alive = false;
    };
  }, [stage, shots, roll, renderOutput]);

  const remaining = session?.remaining ?? 0;

  const resetRoll = () => {
    setShots([]);
    setShotFilters([]);
    setFilterPose(null);
    setThumbs([]);
    setCollage(null);
    setRetakeIdx(null);
    setError("");
    setShareMsg("");
    setLocIssue(false);
  };

  const startSession = (e?: React.FormEvent) => {
    e?.preventDefault();
    const name = guestName.trim();
    if (!name || remaining <= 0) return;
    saveName(name);
    resetRoll();
    setStage("shoot");
  };

  const onCapture = useCallback(
    (snap: HTMLCanvasElement) => {
      const thumb = snap.toDataURL("image/jpeg", 0.6);
      if (retakeIdx !== null) {
        const i = retakeIdx;
        setShots((s) => s.map((x, j) => (j === i ? snap : x)));
        setShotFilters((f) => f.map((x, j) => (j === i ? filter : x)));
        setThumbs((t) => t.map((x, j) => (j === i ? thumb : x)));
        setRetakeIdx(null);
        setStage("result");
        return;
      }
      const n = shots.length + 1;
      setShots((s) => [...s, snap]);
      setShotFilters((f) => [...f, filter]);
      setThumbs((t) => [...t, thumb]);
      if (n >= roll) setStage("result");
    },
    [retakeIdx, shots.length, roll, filter],
  );

  const retakePose = (i: number) => {
    // the camera starts on the filter this pose had
    if (shotFilters[i]) setFilter(shotFilters[i]);
    setRetakeIdx(i);
    setError("");
    setStage("shoot");
  };

  // result screen filter chips: change one pose, or every pose at once
  const pickResultFilter = (id: FilterId) => {
    setFilter(id);
    setShotFilters((f) => f.map((x, i) => (filterPose === null || i === filterPose ? id : x)));
  };
  const chipOn = (id: FilterId) =>
    filterPose === null ? shotFilters.length > 0 && shotFilters.every((x) => x === id) : shotFilters[filterPose] === id;

  const fileName = () => `seribu-lensa-${eventName(event).replace(/&/g, "")}-${Date.now()}.jpg`.toLowerCase().replace(/\s+/g, "-");

  const download = () => {
    if (!collage) return;
    const a = document.createElement("a");
    a.href = collage.url;
    a.download = fileName();
    a.click();
  };

  /**
   * Websites cannot post to Instagram directly. On phones the system share
   * sheet (Web Share API with the photo file) lists Instagram — Feed, Story or
   * DM — with the collage attached. Elsewhere: save it and open Instagram.
   * The caption (with @seribu.lensa) is copied so it can be pasted.
   */
  const shareInstagram = async () => {
    if (!collage) return;
    setSharing(true);
    setShareMsg("");
    const caption = `${momentCaption(event)} · foto oleh ${BRAND.instagram}`;
    let copied = false;
    try {
      await navigator.clipboard.writeText(caption);
      copied = true;
    } catch {
      /* clipboard not available */
    }
    try {
      const files = [new File([await canvasToBlob(collage.canvas, "image/jpeg", 0.92)], fileName(), { type: "image/jpeg" })];
      if (navigator.canShare?.({ files })) {
        await navigator.share({ files, text: caption });
        setShareMsg(`Pilih Instagram di menu bagikan.${copied ? " Caption sudah disalin — tinggal tempel." : ""}`);
      } else {
        download();
        window.open("https://www.instagram.com/", "_blank", "noopener");
        setShareMsg(`Foto sudah tersimpan. Di Instagram, buat postingan/story lalu pilih fotonya.${copied ? " Caption sudah disalin." : ""}`);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") setShareMsg("Gagal membuka menu bagikan. Download fotonya, lalu unggah dari aplikasi Instagram.");
    } finally {
      setSharing(false);
    }
  };

  /** Uploads the collage (one photo of the device quota). */
  const post = async (freshFix?: LocationFix) => {
    const name = guestName.trim();
    if (!session || !name || remaining <= 0 || shots.length < roll || posting) return;
    saveName(name);
    setError("");
    setLocIssue(false);
    setPosting({ pct: null });
    let reservationId = "";
    try {
      // fresh location for the upload; the server re-checks it
      let location: LocationFix | undefined = freshFix;
      if (!location && session.locationRequired !== false) {
        try {
          location = await getPosition(12000);
        } catch (err) {
          if (Date.parse(session.locationValidUntil) <= Date.now()) throw err;
        }
      }
      await ensureFrameFonts();
      // upload the version without the studio credit: the server keeps it clean
      // for the couple and adds its own watermark to the gallery copy
      const clean = renderOutput(false);
      const blob = await canvasToBlob(clean, "image/jpeg", 0.9);
      const auth = await api.guest.authorize({
        guestName: name,
        wishes: wishes.trim(),
        filter: shotFilters[0] ?? filter,
        mode: mode === "moment" ? "moment" : "photobooth",
        contentType: "image/jpeg",
        size: blob.size,
        location,
      });
      reservationId = auth.reservationId;
      setSession(auth.session);
      await putFile(auth.upload, blob, (pct) => setPosting({ pct }));
      const res = await api.guest.complete(reservationId);
      reservationId = "";
      setSession(res.session);
      setPendingApproval(res.photo.approval === "PENDING");
      setStage("posted");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      if (reservationId) api.guest.cancel(reservationId).then(setSession).catch(() => undefined);
      if (
        (err instanceof LocationError && err.code !== "DENIED" && err.code !== "UNSUPPORTED") ||
        (err instanceof ApiError && ["LOCATION_STALE", "LOCATION_INACCURATE", "LOCATION_REQUIRED", "OUTSIDE_RADIUS"].includes(err.code))
      )
        setLocIssue(true);
      if (err instanceof LocationError) setError(`${OUTSIDE_AREA_MESSAGE} ${err.message}`);
      else if (err instanceof ApiError && err.code === "OUTSIDE_RADIUS") setError(OUTSIDE_AREA_MESSAGE);
      else if (err instanceof ApiError && err.code === "LOCATION_STALE")
        setError("Lokasi terbaru belum terdeteksi. Pastikan GPS aktif dan kamu berada di lokasi acara, lalu tekan kirim lagi.");
      else setError((err as Error).message);
      if (err instanceof ApiError) {
        if (err.status === 401) setAccess({ kind: "need-qr" });
        else if (["EVENT_PAUSED", "EVENT_ENDED", "EVENT_NOT_ACTIVE", "EVENT_NOT_STARTED"].includes(err.code)) loadSession();
        else if (err.code === "QUOTA_EXCEEDED") api.guest.session().then(setSession).catch(() => undefined);
      }
    } finally {
      setPosting(null);
    }
  };

  /** Ask for the location again (waiting longer for a fresh GPS fix), then resend. */
  const refreshLocationAndSend = async () => {
    setLocating(true);
    setError("");
    try {
      const fix = await getPosition(25000);
      setSession(await api.guest.location(fix));
      setLocIssue(false);
      setLocating(false);
      await post(fix);
    } catch (err) {
      if (err instanceof ApiError && err.code === "OUTSIDE_RADIUS") setError(OUTSIDE_AREA_MESSAGE);
      else setError((err as Error).message);
      if (err instanceof LocationError && (err.code === "DENIED" || err.code === "UNSUPPORTED")) setLocIssue(false);
    } finally {
      setLocating(false);
    }
  };

  const head = (title: React.ReactNode, sub?: React.ReactNode) => (
    <div className="page-head center">
      <span className="eyebrow">Photobooth digital</span>
      <h1>{title}</h1>
      {sub}
    </div>
  );

  if (access.kind !== "ready") {
    return (
      <div className="page">
        <div className="container-narrow">
          {head(
            <>
              Say <em>cheese!</em>
            </>,
            <>
              <p className={styles.tagline}>Semua tamu adalah Fotografer</p>
              <p className={styles.credit}>
                oleh <strong>{BRAND.name}</strong> ·{" "}
                <a href={BRAND.instagramUrl} target="_blank" rel="noopener noreferrer">
                  {BRAND.instagram}
                </a>
              </p>
            </>,
          )}
          <BoothGate access={access} onRetry={() => (qrRef.current ? checkin() : loadSession())} />
          <HowTo />
          <p className={styles.privacy}>Kami memakai cookie hanya untuk sesi photobooth.</p>
        </div>
      </div>
    );
  }

  /* ---------- 1. Intro: how it works + name ---------- */
  if (stage === "intro") {
    return (
      <div className="page">
        <div className="container-narrow">
          {head(
            <>
              Say <em>cheese!</em>
            </>,
            <p className={styles.tagline}>{eventName(event)}</p>,
          )}
          <div className={`card card-pad ${styles.intro}`}>
            <div className={styles.modes} role="radiogroup" aria-label="Pilih jenis foto">
              <button
                type="button"
                role="radio"
                aria-checked={mode === "booth"}
                className={`${styles.mode} ${mode === "booth" ? styles.modeOn : ""}`}
                onClick={() => setMode("booth")}
              >
                <span className={styles.modeIcon}>
                  <LayoutGrid />
                </span>
                <strong>Photobooth</strong>
                <small>
                  {poses} pose jadi satu kolase{frames.length ? " dengan bingkai acara" : ""}
                </small>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === "moment"}
                className={`${styles.mode} ${mode === "moment" ? styles.modeOn : ""}`}
                onClick={() => setMode("moment")}
              >
                <span className={styles.modeIcon}>
                  <ImageIcon />
                </span>
                <strong>Momen</strong>
                <small>1 foto bebas, tanpa bingkai</small>
              </button>
            </div>

            {mode === "booth" && frames.length > 1 && (
              <div className={styles.framePick}>
                <span className={styles.label}>Pilih bingkai</span>
                <div className={`${styles.frameList} ${frames.length > 3 ? styles.frameListFour : ""}`} role="radiogroup" aria-label="Pilih bingkai">
                  {frames.map((f, i) => {
                    const on = f.id === activeFrame?.id;
                    const n = windows[f.url];
                    return (
                      <button
                        key={f.id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        className={`${styles.frameOpt} ${on ? styles.frameOptOn : ""}`}
                        onClick={() => setFrameId(f.id)}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={photoSrc(f.url)} alt={`Bingkai ${i + 1}`} />
                        <small>{n ? `${n} pose` : `Bingkai ${i + 1}`}</small>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {remaining > 0 ? (
              <form onSubmit={startSession} className={styles.form}>
                <label className={styles.label} htmlFor="guest-name">
                  Nama kamu
                </label>
                <input
                  id="guest-name"
                  className="input"
                  placeholder="Tulis namamu"
                  value={guestName}
                  maxLength={60}
                  autoComplete="name"
                  onChange={(e) => setGuestName(e.target.value)}
                  required
                />
                <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={!guestName.trim()}>
                  <Camera /> Mulai Foto
                </button>
                <p className={`hint ${styles.centerText}`}>
                  Sisa {remaining} kiriman untuk HP ini · 1 kolase atau 1 momen = 1 kiriman
                </p>
              </form>
            ) : (
              <div className={styles.form}>
                <p className="alert alert-success" role="status">
                  <CheckCircle2 /> Kuota HP ini sudah terpakai semua. Terima kasih sudah ikut meramaikan!
                </p>
                <Link href="/gallery" className="btn btn-secondary btn-block">
                  <Images /> Lihat Galeri
                </Link>
              </div>
            )}
          </div>
          <p className={styles.privacy}>
            Photobooth oleh <strong>{BRAND.name}</strong> · Kami memakai cookie hanya untuk sesi photobooth.
          </p>
        </div>
      </div>
    );
  }

  /* ---------- 2. Camera: 4 poses ---------- */
  if (stage === "shoot") {
    return (
      <CameraScreen
        event={event}
        session={session}
        filter={filter}
        onFilter={setFilter}
        shotCount={shots.length}
        rollSize={roll}
        aspects={rollAspects}
        retakeIndex={retakeIdx}
        thumbs={thumbs}
        onCapture={onCapture}
        onCancel={
          retakeIdx !== null
            ? () => {
                setRetakeIdx(null);
                setStage("result");
              }
            : undefined
        }
      />
    );
  }

  /* ---------- 3. Result & 4. Posted ---------- */
  const posted = stage === "posted";
  const sendLabel = isWedding(event) ? "Kirim ke pengantin" : "Kirim ke galeri acara";

  return (
    <div className="page">
      <div className="container-narrow">
        {head(posted ? <>Terkirim!</> : mode === "moment" ? <>Momenmu <em>jadi!</em></> : <>Kolasemu <em>jadi!</em></>)}

        <div className={styles.collageWrap}>
          {collage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={collage.url} alt={mode === "moment" ? "Foto momen" : "Kolase photobooth"} className={styles.collage} />
          ) : (
            <div className={styles.collageLoading}>
              <span className="spinner" />
            </div>
          )}
        </div>

        {posted ? (
          <div className={`card card-pad ${styles.posted}`}>
            <span className={styles.postedIcon}>
              <CheckCircle2 />
            </span>
            <p className="muted">
              {pendingApproval
                ? `${mode === "moment" ? "Fotomu" : "Kolasemu"} menunggu persetujuan tuan rumah sebelum tampil di galeri dan layar acara.`
                : `${mode === "moment" ? "Fotomu" : "Kolasemu"} sedang diproses dan segera tayang di galeri dan layar acara. Terima kasih sudah ikut meramaikan!`}
            </p>
            <button className="btn btn-primary btn-block" onClick={shareInstagram} disabled={sharing || !collage}>
              {sharing ? <span className="spinner" /> : <Instagram />} Share ke Instagram
            </button>
            <button className="btn btn-secondary btn-block" onClick={download} disabled={!collage}>
              <Download /> Simpan ke HP
            </button>
            {shareMsg && <p className="hint" role="status">{shareMsg}</p>}
            <div className={styles.row}>
              {remaining > 0 && (
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    resetRoll();
                    setWishes("");
                    setShowWishes(false);
                    setStage("intro");
                  }}
                >
                  <Camera /> Foto lagi
                </button>
              )}
              <Link href="/gallery" className="btn btn-secondary">
                <Images /> Lihat Galeri
              </Link>
            </div>
            <p className="hint">{remaining > 0 ? `Sisa ${remaining} sesi untuk HP ini.` : "Kuota HP ini sudah terpakai semua."}</p>
          </div>
        ) : (
          <>
            <div className={`card card-pad ${styles.sendCard}`}>
              {error && (
                <div className="alert alert-error" role="alert">
                  <AlertCircle /> {error}
                </div>
              )}
              {(locIssue || locating) && remaining > 0 && (
                <button type="button" className="btn btn-secondary btn-block" onClick={refreshLocationAndSend} disabled={locating || !!posting}>
                  {locating ? (
                    <>
                      <span className="spinner" /> Mencari lokasi…
                    </>
                  ) : (
                    <>
                      <MapPin /> Perbarui lokasi &amp; kirim
                    </>
                  )}
                </button>
              )}

              {remaining > 0 ? (
                <>
                  {editingName || !guestName.trim() ? (
                    <input
                      className="input"
                      placeholder="Nama kamu *"
                      value={guestName}
                      maxLength={60}
                      autoComplete="name"
                      onChange={(e) => setGuestName(e.target.value)}
                    />
                  ) : null}

                  <button
                    type="button"
                    className="btn btn-primary btn-block btn-lg"
                    onClick={() => void post()}
                    disabled={!!posting || locating || !collage || !guestName.trim()}
                  >
                    {posting ? <span className="spinner" /> : <Send />}{" "}
                    {posting ? `Mengirim…${posting.pct ? ` ${posting.pct}%` : ""}` : sendLabel}
                  </button>
                  <button type="button" className="btn btn-secondary btn-block" onClick={shareInstagram} disabled={sharing || !collage}>
                    {sharing ? <span className="spinner" /> : <Instagram />} Upload ke Instagram
                  </button>
                  {shareMsg && (
                    <p className={`hint ${styles.centerText}`} role="status">
                      {shareMsg}
                    </p>
                  )}
                  {!editingName && guestName.trim() && (
                    <p className={`hint ${styles.centerText}`}>
                      Dikirim sebagai <strong>{guestName.trim()}</strong> ·{" "}
                      <button type="button" className={styles.inlineLink} onClick={() => setEditingName(true)}>
                        ubah
                      </button>
                    </p>
                  )}
                  {showWishes ? (
                    <textarea
                      className="textarea"
                      rows={2}
                      maxLength={500}
                      autoFocus
                      placeholder={isWedding(event) ? "Ucapan untuk mempelai (opsional)" : "Ucapan atau pesan singkat (opsional)"}
                      value={wishes}
                      onChange={(e) => setWishes(e.target.value)}
                    />
                  ) : (
                    <button type="button" className={styles.linkBtn} onClick={() => setShowWishes(true)}>
                      <MessageSquare /> Tambah ucapan (opsional)
                    </button>
                  )}
                </>
              ) : (
                <>
                  <p className="hint">Kuota kirim HP ini sudah habis. Fotomu tetap bisa disimpan dan dibagikan.</p>
                  <button className="btn btn-primary btn-block" onClick={shareInstagram} disabled={sharing || !collage}>
                    {sharing ? <span className="spinner" /> : <Instagram />} Upload ke Instagram
                  </button>
                  <button className="btn btn-secondary btn-block" onClick={download} disabled={!collage}>
                    <Download /> Simpan ke HP
                  </button>
                  {shareMsg && <p className="hint" role="status">{shareMsg}</p>}
                </>
              )}
            </div>

            <div className={styles.tweak}>
              <h3 className={styles.groupTitle}>Kurang pas? Ketuk pose untuk ulang</h3>
              <div className={styles.retakeRow}>
                {thumbs.map((t, i) => (
                  <button key={i} className={styles.retakeBtn} onClick={() => retakePose(i)} disabled={!!posting} aria-label={`Ulang pose ${i + 1}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={t} alt="" style={filterStyle(shotFilters[i] ?? "none")} />
                    <span>
                      <RotateCcw /> {i + 1}
                    </span>
                  </button>
                ))}
              </div>

              {thumbs.length > 1 && (
                <div>
                  <h3 className={styles.groupTitle}>Ganti filter untuk</h3>
                  <div className={styles.filterRow} role="radiogroup" aria-label="Pose yang diganti filternya">
                    {[null, ...thumbs.map((_, i) => i)].map((p) => (
                      <button
                        key={p ?? "all"}
                        role="radio"
                        aria-checked={filterPose === p}
                        className={`chip ${filterPose === p ? "active" : ""}`}
                        onClick={() => setFilterPose(p)}
                        disabled={!!posting}
                      >
                        {p === null ? "Semua pose" : `Pose ${p + 1}`}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {FILTER_GROUPS.map((g) => (
                <div key={g.id}>
                  <h3 className={styles.groupTitle}>{g.id === "disposable" ? "Filter disposable camera" : "Filter"}</h3>
                  <div className={styles.filterRow} role="radiogroup" aria-label={`Filter ${g.name}`}>
                    {filtersInGroup(g.id).map((f) => (
                      <button
                        key={f.id}
                        role="radio"
                        aria-checked={chipOn(f.id)}
                        className={`chip ${chipOn(f.id) ? "active" : ""}`}
                        onClick={() => pickResultFilter(f.id)}
                        disabled={!!posting}
                        style={{ "--dot": f.color } as React.CSSProperties}
                      >
                        <span className="dot" /> {f.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => {
                  resetRoll();
                  setStage("shoot");
                }}
                disabled={!!posting}
              >
                <RefreshCw /> Ulang semua pose
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Simple Instagram-style glyph (lucide no longer ships brand icons). */
function Instagram() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.6" fill="currentColor" />
    </svg>
  );
}

/* ---------- Access gate (QR → location → session) ---------- */

/** Appears when finding the location takes long (GPS off / weak indoors). */
function SlowLocateHint() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(t);
  }, []);
  if (!slow) return null;
  return (
    <p className="hint" style={{ marginTop: 8 }}>
      Masih mencari lokasi… Pastikan <strong>Lokasi/GPS</strong> di HP menyala (tarik menu atas HP), lalu tunggu
      sebentar. Di Android, aktifkan juga <strong>Akurasi Lokasi Google</strong>.
    </p>
  );
}

function BoothGate({ access, onRetry }: { access: Access; onRetry: () => void }) {
  if (access.kind === "checking" || access.kind === "locating") {
    return (
      <div className="card empty" role="status">
        <span className="empty-icon">{access.kind === "locating" ? <MapPin /> : <span className="spinner" />}</span>
        <h3>{access.kind === "locating" ? "Memeriksa lokasimu…" : "Menyiapkan photobooth…"}</h3>
        <p>
          {access.kind === "locating"
            ? "Izinkan akses lokasi saat diminta. Photobooth hanya aktif di area acara."
            : "Sebentar ya."}
        </p>
        {access.kind === "locating" && <SlowLocateHint />}
      </div>
    );
  }
  if (access.kind === "need-qr") {
    return (
      <div className={`card empty ${styles.gate}`}>
        <span className={styles.gateSpark} style={{ top: 28, right: "14%" }} aria-hidden="true">✦</span>
        <span className={styles.gateSpark} style={{ bottom: 36, left: "12%", fontSize: "0.8rem" }} aria-hidden="true">✦</span>
        <span className="empty-icon">
          <QrCode />
        </span>
        <h3>Scan QR photobooth</h3>
        <p>Photobooth hanya bisa dibuka lewat QR yang tampil di layar atau meja acara. Minta QR-nya ke penyelenggara, lalu scan dengan kamera HP.</p>
        <Link href="/gallery" className="btn btn-secondary">
          <Images /> Lihat Galeri
        </Link>
      </div>
    );
  }
  if (access.kind === "blocked") {
    const Icon = access.title.includes("QR") ? QrCode : access.title.includes("ditutup") || access.title.includes("belum") ? Clock : MapPin;
    return (
      <div className="card empty" role="alert">
        <span className="empty-icon">
          <Icon />
        </span>
        <h3>{access.title}</h3>
        <p>{access.message}</p>
        {access.canRetry && (
          <button className="btn btn-primary" onClick={onRetry}>
            <RefreshCw /> Coba Lagi
          </button>
        )}
      </div>
    );
  }
  return null;
}

const HOW_TO = [
  { src: "/cara-pakai/v2-1-scan-qr.jpg", alt: "01 Scan QR — Arahkan kamera ke kode QR untuk membuka halaman foto." },
  { src: "/cara-pakai/v2-2-isi-nama.jpg", alt: "02 Isi nama — Masukkan namamu agar hasil foto mudah ditemukan." },
  { src: "/cara-pakai/v2-3-jepret-foto.jpg", alt: "03 Jepret foto — Kamera langsung terbuka. Pilih pose terbaikmu lalu jepret!" },
  { src: "/cara-pakai/v2-4-bagikan-fotomu.jpg", alt: "04 Bagikan fotomu — Upload ke Instagram dan kirim ke galeri acara." },
];

/** Illustrated 3-step guide so guests see what the photobooth does before scanning. */
function HowTo() {
  return (
    <section aria-labelledby="howto-title">
      <div className={styles.howToHead}>
        <span className="eyebrow">Cara pakai</span>
        <h2 id="howto-title">Empat langkah, satu kenangan</h2>
      </div>
      <ol className={styles.howTo}>
        {HOW_TO.map((s) => (
          <li key={s.src}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={s.src}
              alt={s.alt}
              width={900}
              height={1124}
              loading="lazy"
              // a missing illustration hides its card instead of showing a broken image
              onError={(e) => ((e.currentTarget.parentElement as HTMLElement).hidden = true)}
            />
          </li>
        ))}
      </ol>
      <p className={styles.howToSwipe} aria-hidden="true">
        Geser untuk langkah berikutnya →
      </p>
    </section>
  );
}
