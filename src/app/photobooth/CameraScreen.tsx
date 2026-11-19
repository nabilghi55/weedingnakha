"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CameraOff, Images, RefreshCw, SwitchCamera, Timer, TimerOff, Zap, ZapOff } from "lucide-react";
import { FilterOverlay, filterStyle } from "@/components/FilterPicker";
import type { FilterId, GuestSession, WeddingEvent } from "@/lib/api";
import { FILTER_GROUPS, filtersInGroup } from "@/lib/filters";
import { takeSnapshot } from "@/lib/frames";
import { BRAND } from "@/lib/brand";
import styles from "./camera.module.css";
import { eventName } from "@/lib/format";

type ZoomCaps = { min: number; max: number } | null;

/** MediaTrack capabilities that are not in the TS DOM lib yet. */
type ExtCaps = MediaTrackCapabilities & { zoom?: { min: number; max: number }; torch?: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function timeLeft(closesAt: string, now: number) {
  const ms = Date.parse(closesAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "Photobooth segera ditutup";
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d} hari ${h} jam tersisa`;
  if (h > 0) return `${h} jam ${m % 60} mnt tersisa`;
  return `${m} mnt tersisa`;
}

/** Self-timer choices (seconds, 0 = shoot right away); the last choice is kept per phone. */
const TIMER_OPTIONS = [0, 3, 5, 10] as const;
const TIMER_KEY = "nakha_timer";

function readTimer(): number {
  try {
    const v = Number(localStorage.getItem(TIMER_KEY));
    return (TIMER_OPTIONS as readonly number[]).includes(v) ? v : 3;
  } catch {
    return 3;
  }
}

/**
 * Full-screen camera for one photobooth session: the guest presses the shutter
 * for each pose (optional self-timer, then the shot), a mini 2×2 grid shows the
 * collage filling up. Square viewfinder = exactly what lands in the collage.
 */
export default function CameraScreen({
  event,
  session,
  filter,
  onFilter,
  shotCount,
  rollSize,
  aspects,
  retakeIndex,
  thumbs,
  onCapture,
  onCancel,
}: {
  event: WeddingEvent;
  session: GuestSession | null;
  filter: FilterId;
  onFilter: (f: FilterId) => void;
  shotCount: number;
  rollSize: number;
  /** width/height of each pose (the event frame's windows); square when absent */
  aspects?: number[];
  /** set while re-shooting one pose of the collage */
  retakeIndex: number | null;
  /** one thumbnail per pose taken so far (index = pose) */
  thumbs: string[];
  onCapture: (snapshot: HTMLCanvasElement) => void;
  /** leave a retake without shooting (back to the result) */
  onCancel?: () => void;
}) {
  // shape of the frame window the next (or retaken) pose fills
  const poseAspect = aspects?.[retakeIndex ?? shotCount] ?? 1;
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [state, setState] = useState<"idle" | "on" | "denied" | "insecure">("idle");
  const [retry, setRetry] = useState(0);
  const [hwZoom, setHwZoom] = useState<ZoomCaps>(null);
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [flashOn, setFlashOn] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [timer, setTimer] = useState(3);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
    setTimer(readTimer());
  }, []);
  const cycleTimer = () => {
    const next = TIMER_OPTIONS[(TIMER_OPTIONS.indexOf(timer as (typeof TIMER_OPTIONS)[number]) + 1) % TIMER_OPTIONS.length];
    setTimer(next);
    try {
      localStorage.setItem(TIMER_KEY, String(next));
    } catch {
      /* private mode */
    }
  };
  const [screenFlash, setScreenFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0); // set after mount: keeps server and client HTML identical

  // no page scroll behind the full-screen camera
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 30000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  // camera lifecycle
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        // browsers hide the camera API entirely on plain http:// (except localhost)
        setState(window.isSecureContext ? "denied" : "insecure");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1920 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        const caps = (stream.getVideoTracks()[0]?.getCapabilities?.() ?? {}) as ExtCaps;
        setHwZoom(caps.zoom && caps.zoom.max > caps.zoom.min ? { min: caps.zoom.min, max: caps.zoom.max } : null);
        setTorch(!!caps.torch);
        setZoom(1);
        setState("on");
      } catch {
        if (!cancelled) setState("denied");
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [facing, retry]);

  // .5x only when the camera really has an ultra-wide zoom range; 2x falls back to a centre crop
  const zoomLevels = [...(hwZoom && hwZoom.min <= 0.5 ? [0.5] : []), 1, 2];
  const isHwZoom = (z: number) => !!hwZoom && z >= hwZoom.min && z <= hwZoom.max;
  const digitalZoom = isHwZoom(zoom) ? 1 : zoom;

  const pickZoom = async (z: number) => {
    setZoom(z);
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !hwZoom) return;
    const hw = isHwZoom(z) ? z : 1;
    try {
      await track.applyConstraints({ advanced: [{ zoom: hw } as MediaTrackConstraintSet] });
    } catch {
      /* keep the digital fallback */
    }
  };

  const shoot = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const track = streamRef.current?.getVideoTracks()[0];
    const useTorch = flashOn && torch && facing === "environment";
    if (flashOn && useTorch && track) {
      try {
        await track.applyConstraints({ advanced: [{ torch: true } as MediaTrackConstraintSet] });
        await sleep(350);
      } catch {
        /* ignore */
      }
    } else if (flashOn) {
      // front camera: light the face with a white screen
      setScreenFlash(true);
      await sleep(280);
    }
    const snap = takeSnapshot(video, facing === "user", digitalZoom, poseAspect);
    if (useTorch && track) track.applyConstraints({ advanced: [{ torch: false } as MediaTrackConstraintSet] }).catch(() => undefined);
    setScreenFlash(false);
    onCapture(snap);
  }, [digitalZoom, facing, flashOn, onCapture, torch, poseAspect]);

  const capture = async () => {
    if (busy || state !== "on") return;
    setBusy(true);
    for (let n = timer; n > 0; n--) {
      setCountdown(n);
      await sleep(1000);
    }
    setCountdown(null);
    await shoot();
    setBusy(false);
  };

  const mirror = facing === "user" ? "scaleX(-1) " : "";

  return (
    <div className={styles.cam} role="dialog" aria-label="Kamera photobooth">
      <header className={styles.top}>
        <Link href="/gallery" className={styles.round} aria-label="Kembali ke galeri">
          <ArrowLeft />
        </Link>
        <div className={styles.title}>
          <small className={styles.brandLine}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={BRAND.logoLight} alt="" width={512} height={341} />
            {BRAND.name}
          </small>
          <strong>
            {eventName(event)}
          </strong>
          {session && now > 0 && <span>{timeLeft(session.booth.closesAt, now)}</span>}
        </div>
        <Link href="/gallery" className={styles.round} aria-label="Galeri">
          <Images />
        </Link>
      </header>

      <div className={styles.viewArea}>
        <div
          className={styles.viewport}
          // preview has the exact shape of the frame window this pose fills
          style={{ width: `min(100cqw, ${(100 * poseAspect).toFixed(2)}cqh)`, aspectRatio: String(poseAspect) }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={styles.video}
            style={{ ...filterStyle(filter), transform: `${mirror}scale(${digitalZoom})` }}
          />
          <FilterOverlay filter={filter} />

          {state !== "on" && (
            <div className={styles.placeholder}>
              {state === "insecure" ? (
                <>
                  <CameraOff />
                  <strong>Kamera butuh koneksi aman</strong>
                  <span>Halaman ini dibuka lewat http://, jadi browser memblokir kamera. Buka photobooth lewat link https://.</span>
                </>
              ) : state === "denied" ? (
                <>
                  <CameraOff />
                  <strong>Kamera tidak tersedia</strong>
                  <span>Izinkan akses kamera di pengaturan browser, lalu coba lagi.</span>
                  <button
                    className="btn btn-light btn-sm"
                    onClick={() => {
                      setState("idle");
                      setRetry((n) => n + 1);
                    }}
                  >
                    <RefreshCw /> Coba lagi
                  </button>
                </>
              ) : (
                <>
                  <span className="spinner" />
                  <span>Menyalakan kamera…</span>
                </>
              )}
            </div>
          )}

          <button
            className={`${styles.round} ${styles.flashBtn} ${flashOn ? styles.on : ""}`}
            onClick={() => setFlashOn((f) => !f)}
            aria-label={flashOn ? "Flash nyala" : "Flash mati"}
            aria-pressed={flashOn}
          >
            {flashOn ? <Zap /> : <ZapOff />}
          </button>

          <button
            className={`${styles.round} ${styles.timerBtn} ${timer ? styles.on : ""}`}
            onClick={cycleTimer}
            disabled={busy}
            aria-label={timer ? `Timer ${timer} detik` : "Timer mati"}
          >
            {timer ? <Timer /> : <TimerOff />}
            {timer > 0 && <small>{timer}</small>}
          </button>

          <div className={styles.zoom} role="radiogroup" aria-label="Zoom">
            {zoomLevels.map((z) => (
              <button
                key={z}
                role="radio"
                aria-checked={zoom === z}
                className={zoom === z ? styles.zoomOn : ""}
                onClick={() => pickZoom(z)}
                disabled={state !== "on"}
              >
                {z === 0.5 ? ".5" : z}×
              </button>
            ))}
          </div>
          <button
            className={`${styles.round} ${styles.flipBtn}`}
            onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))}
            disabled={state !== "on"}
            aria-label="Ganti kamera"
          >
            <SwitchCamera />
          </button>

          {countdown !== null && (
            <div className={styles.countdown} key={countdown}>
              {countdown}
            </div>
          )}
        </div>
      </div>

      <div className={styles.filters} role="radiogroup" aria-label="Filter">
        {FILTER_GROUPS.map((g) => (
          <Fragment key={g.id}>
            <span className={styles.filterGroup}>{g.name}</span>
            {filtersInGroup(g.id).map((f) => (
              <button
                key={f.id}
                role="radio"
                aria-checked={filter === f.id}
                className={filter === f.id ? styles.filterOn : ""}
                onClick={() => onFilter(f.id)}
              >
                {f.name}
              </button>
            ))}
          </Fragment>
        ))}
      </div>

      <p className={styles.poseHint} aria-live="polite">
        {busy
          ? "Siap… bergaya!"
          : retakeIndex !== null
            ? `Ulang pose ${retakeIndex + 1} — tekan tombol, lalu bergaya`
            : shotCount === 0
              ? `Pose 1 dari ${rollSize} — tekan tombol, lalu bergaya`
              : `Mantap! Ganti gaya untuk pose ${shotCount + 1} dari ${rollSize}`}
      </p>

      <footer className={styles.bottom}>
        <div className={styles.miniGrid} aria-label={`${shotCount} dari ${rollSize} pose`}>
          {Array.from({ length: rollSize }, (_, i) => (
            <span key={i} className={i === (retakeIndex ?? shotCount) ? styles.miniNext : ""}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {thumbs[i] && retakeIndex !== i ? <img src={thumbs[i]} alt="" /> : <small>{i + 1}</small>}
            </span>
          ))}
        </div>
        <button className={styles.shutter} onClick={capture} disabled={state !== "on" || busy} aria-label={`Ambil pose ${(retakeIndex ?? shotCount) + 1}`}>
          <span />
        </button>
        {retakeIndex !== null && onCancel ? (
          <button className={styles.poseCount} onClick={onCancel} disabled={busy}>
            <strong>Batal</strong>
            <small>Ulang pose</small>
          </button>
        ) : (
          <div className={styles.poseCount}>
            <strong>
              {Math.min(shotCount + 1, rollSize)}
              <small>/{rollSize}</small>
            </strong>
            <small>Pose</small>
          </div>
        )}
      </footer>

      {screenFlash && <div className={styles.screenFlash} />}
    </div>
  );
}
