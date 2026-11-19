"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Download, Film, Maximize, Minimize } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { api, ApiError } from "@/lib/api";
import { ensureFrameFonts } from "@/lib/frames";
import { CARD_SIZES, cardPng, drawCard, qrMatrix, readTheme, recordCardVideo, type CardFormat } from "@/lib/qrcard";
import styles from "./qr.module.css";
import { eventName } from "@/lib/format";

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Animated QR card for the venue screen and for printing — host only. The QR
 * is fixed per event (until the host rotates it); it only works while the
 * photobooth window is open and inside the geofence.
 */
export default function QrCardPage() {
  const { event, setEvent } = useApp();
  const [uploadUrl, setUploadUrl] = useState("");
  const [qrState, setQrState] = useState<"loading" | "ok" | "closed" | "denied">("loading");
  const [closedMsg, setClosedMsg] = useState("");
  const [window_, setWindow] = useState<{ opensAt: string; closesAt: string } | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    api.host
      .me()
      .then((ev) => alive && setEvent(ev))
      .catch(() => undefined);
    const tick = async () => {
      try {
        const qr = await api.host.qr();
        if (!alive) return;
        setUploadUrl(qr.url);
        setWindow({ opensAt: qr.opensAt, closesAt: qr.closesAt });
        setQrState("ok");
        timer = setTimeout(tick, Math.max(30000, qr.refreshAfterMs));
      } catch (err) {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 401) {
          setQrState("denied");
          return;
        }
        setUploadUrl("");
        setQrState("closed");
        setClosedMsg((err as Error).message);
        timer = setTimeout(tick, 60000);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [setEvent]);

  const [format, setFormat] = useState<CardFormat>("card");
  const [fontsReady, setFontsReady] = useState(false);
  const [busy, setBusy] = useState<"png" | "video" | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const qr = useMemo(() => (uploadUrl ? qrMatrix(uploadUrl) : null), [uploadUrl]);
  const fileBase = `kartu-qr-${eventName(event).replace(/&/g, "")}-${format}`.toLowerCase().replace(/\s+/g, "-");

  useEffect(() => {
    ensureFrameFonts().then(() => setFontsReady(true));
  }, []);

  // live animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !qr || !fontsReady) return;
    const { w, h } = CARD_SIZES[format];
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    const theme = readTheme();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    let raf = 0;
    const frame = () => {
      drawCard(ctx, format, (performance.now() - start) / 1000, event, qr, theme, { still, url: uploadUrl });
      if (!still) raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [format, qr, fontsReady, event, uploadUrl]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const downloadPng = async () => {
    setBusy("png");
    setError("");
    try {
      await ensureFrameFonts();
      save(await cardPng(format, event, uploadUrl), `${fileBase}.png`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const downloadVideo = async () => {
    setBusy("video");
    setError("");
    setProgress(0);
    try {
      await ensureFrameFonts();
      const { blob, ext } = await recordCardVideo(format, event, uploadUrl, setProgress);
      save(blob, `${fileBase}.${ext}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) rootRef.current?.requestFullscreen().catch(() => undefined);
    else document.exitFullscreen().catch(() => undefined);
  };

  return (
    <div ref={rootRef} className={styles.root}>
      <div className={styles.stage}>
        <canvas ref={canvasRef} className={styles.canvas} aria-label="Kartu QR photobooth" />
      </div>
      {qrState !== "ok" && (
        <div className={styles.error} role="status">
          {qrState === "loading" && "Menyiapkan QR…"}
          {qrState === "closed" && `QR tidak ditampilkan: ${closedMsg}`}
          {qrState === "denied" && (
            <>
              Halaman ini khusus tuan rumah. <Link href="/host">Buka dashboard tuan rumah</Link>.
            </>
          )}
        </div>
      )}
      {qrState === "ok" && window_ && (
        <div className={styles.hint}>
          QR tetap — PNG/video boleh dicetak & dipajang. Berfungsi{" "}
          {new Date(window_.opensAt).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} –{" "}
          {new Date(window_.closesAt).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.
        </div>
      )}

      <div className={styles.toolbar}>
        <Link href="/host" className={styles.back} aria-label="Kembali ke dashboard">
          <ArrowLeft />
        </Link>
        <div className={styles.segment} role="tablist" aria-label="Format">
          {(Object.keys(CARD_SIZES) as CardFormat[]).map((f) => (
            <button key={f} role="tab" aria-selected={format === f} className={format === f ? styles.segOn : ""} onClick={() => setFormat(f)} disabled={!!busy}>
              {CARD_SIZES[f].label}
            </button>
          ))}
        </div>
        <button className="btn btn-light btn-sm" onClick={downloadPng} disabled={!!busy || !qr}>
          {busy === "png" ? <span className="spinner" /> : <Download />} PNG cetak
        </button>
        <button className="btn btn-primary btn-sm" onClick={downloadVideo} disabled={!!busy || !qr}>
          {busy === "video" ? (
            <>
              <span className="spinner" /> Merekam {Math.round(progress * 100)}%
            </>
          ) : (
            <>
              <Film /> Video animasi
            </>
          )}
        </button>
        <button className={styles.back} onClick={toggleFullscreen} aria-label="Layar penuh">
          {fullscreen ? <Minimize /> : <Maximize />}
        </button>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {busy === "video" && <div className={styles.hint}>Biarkan tab ini tetap terbuka selama ±10 detik…</div>}
    </div>
  );
}
