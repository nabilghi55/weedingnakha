"use client";

import { photoSrc, type Photo } from "@/lib/api";
import styles from "./PhotoCard.module.css";

interface Props {
  photo: Photo;
  onOpen?: () => void;
}

/** Gallery tile: the photo only. Name, time and wishes appear in the lightbox on tap. */
export default function PhotoCard({ photo, onOpen }: Props) {
  return (
    <button className={styles.card} onClick={onOpen} aria-label={`Buka foto dari ${photo.guestName}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photoSrc(photo.thumbUrl || photo.photoUrl)}
        alt={`Foto dari ${photo.guestName}`}
        loading="lazy"
        decoding="async"
        width={photo.width || 3}
        height={photo.height || 4}
      />
    </button>
  );
}
