"use client";

import { useEffect } from "react";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { photoSrc, type Photo } from "@/lib/api";
import { clockTime } from "@/lib/format";
import styles from "./Lightbox.module.css";

interface Props {
  photos: Photo[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}

export default function Lightbox({ photos, index, onIndex, onClose }: Props) {
  const photo = photos[index];
  const count = photos.length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") onIndex((index + 1) % count);
      if (e.key === "ArrowLeft") onIndex((index - 1 + count) % count);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [index, count, onIndex, onClose]);

  useEffect(() => {
    if (!photo) onClose();
  }, [photo, onClose]);

  if (!photo) return null;

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Foto" onClick={onClose}>
      <div className={styles.frame} onClick={(e) => e.stopPropagation()}>
        <div className={styles.imageWrap}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={photo.id} src={photoSrc(photo.photoUrl)} alt={`Foto dari ${photo.guestName}`} />
          {count > 1 && (
            <>
              <button className={`${styles.nav} ${styles.prev}`} onClick={() => onIndex((index - 1 + count) % count)} aria-label="Sebelumnya">
                <ChevronLeft />
              </button>
              <button className={`${styles.nav} ${styles.next}`} onClick={() => onIndex((index + 1) % count)} aria-label="Berikutnya">
                <ChevronRight />
              </button>
            </>
          )}
        </div>

        <aside className={styles.side}>
          <div className={styles.sideHead}>
            <span className="subtle" style={{ fontSize: "0.78rem" }}>
              {index + 1} / {count} · {clockTime(photo.createdAt)}
            </span>
            <button className="icon-btn" onClick={onClose} aria-label="Tutup">
              <X />
            </button>
          </div>
          <h2 className={styles.name}>{photo.guestName}</h2>
          <p className={styles.wish}>&ldquo;{photo.wishes}&rdquo;</p>
          <div className={styles.actions}>
            <a className="btn btn-secondary" href={photoSrc(photo.photoUrl)} download target="_blank" rel="noreferrer">
              <Download /> Simpan
            </a>
          </div>
        </aside>
      </div>
    </div>
  );
}
