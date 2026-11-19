"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, ImageOff, Lock } from "lucide-react";
import { useApp } from "@/context/AppContext";
import PhotoCard from "@/components/PhotoCard";
import Lightbox from "@/components/Lightbox";
import type { Photo } from "@/lib/api";
import styles from "./gallery.module.css";
import { eventName } from "@/lib/format";

/** Number of masonry columns for the current viewport (2 on phones). */
function useColumnCount() {
  const [n, setN] = useState(2);
  useEffect(() => {
    const calc = () => setN(window.innerWidth <= 860 ? 2 : window.innerWidth <= 1100 ? 3 : 4);
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);
  return n;
}

/**
 * Stable masonry: photos are placed oldest → newest into the shortest column,
 * then each column is shown newest-first. A newly published photo only lands
 * on top of one column — nothing else moves (CSS columns reshuffled every card
 * on each new photo, which made scrolling jump on phones).
 */
function layoutColumns(photos: Photo[], n: number) {
  const cols: { photo: Photo; index: number }[][] = Array.from({ length: n }, () => []);
  const heights = new Array(n).fill(0);
  for (let i = photos.length - 1; i >= 0; i--) {
    const p = photos[i];
    const ratio = p.width && p.height ? p.height / p.width : 4 / 3;
    let c = 0;
    for (let k = 1; k < n; k++) if (heights[k] < heights[c] - 0.01) c = k;
    cols[c].push({ photo: p, index: i });
    heights[c] += ratio + 0.45; // + caption block
  }
  return cols.map((col) => col.reverse());
}

export default function GalleryPage() {
  const { photos, event, status, galleryAccess, hasMore, loadMore } = useApp();
  const [loadingMore, setLoadingMore] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const visible = photos;
  const colCount = useColumnCount();
  const columns = useMemo(() => layoutColumns(visible, colCount), [visible, colCount]);

  const close = useCallback(() => setOpenIndex(null), []);

  return (
    <div className="page">
      <div className="container">
        <header className={styles.head}>
          <h1 className={styles.title}>
            Momen dari <em>para tamu</em>
          </h1>
          <p className={styles.subtitle}>
            Foto candid dan ucapan terbaik untuk {eventName(event)}.
          </p>
        </header>

        {galleryAccess === "denied" ? (
          <div className="card empty" data-reveal>
            <span className="empty-icon">
              <Lock />
            </span>
            <h3>Galeri khusus tamu acara</h3>
            <p>
              {event.galleryVisibility === "PRIVATE"
                ? "Galeri acara ini hanya dapat dilihat oleh tuan rumah."
                : "Scan QR photobooth di lokasi acara untuk membuka galeri dan mengirim foto."}
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", marginTop: 8 }}>
              <Link href="/photobooth" className="btn btn-primary">
                <Camera /> Photobooth
              </Link>
            </div>
          </div>
        ) : status === "loading" ? (
          <div className={styles.skeletons}>
            {[320, 240, 380, 280, 300, 260].map((h, i) => (
              <div key={i} className="skeleton" style={{ height: h, marginBottom: 18 }} />
            ))}
          </div>
        ) : visible.length > 0 ? (
          <div className={styles.masonry}>
            {columns.map((col, c) => (
              <div key={c} className={styles.col}>
                {col.map(({ photo, index }) => (
                  <PhotoCard key={photo.id} photo={photo} onOpen={() => setOpenIndex(index)} />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="card empty" data-reveal>
            <span className="empty-icon">
              <ImageOff />
            </span>
            <h3>Belum ada foto</h3>
            <p>Jadilah tamu pertama yang membagikan momen hari ini!</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", marginTop: 8 }}>
              <Link href="/photobooth" className="btn btn-primary">
                <Camera /> Photobooth
              </Link>
            </div>
          </div>
        )}
        {galleryAccess === "granted" && visible.length > 0 && hasMore && (
          <div style={{ display: "flex", justifyContent: "center", marginTop: 28 }}>
            <button
              className="btn btn-secondary"
              disabled={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                await loadMore();
                setLoadingMore(false);
              }}
            >
              {loadingMore ? <span className="spinner" /> : null} Muat foto sebelumnya
            </button>
          </div>
        )}
      </div>

      {openIndex !== null && <Lightbox photos={visible} index={openIndex} onIndex={setOpenIndex} onClose={close} />}
    </div>
  );
}
