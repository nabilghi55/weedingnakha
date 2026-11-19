"use client";

import { photoSrc, type Photo } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import styles from "./PhotoCard.module.css";

interface Props {
  photo: Photo;
  onOpen?: () => void;
  compact?: boolean;
}

export default function PhotoCard({ photo, onOpen, compact }: Props) {
  return (
    <article className={`${styles.card} ${compact ? styles.compact : ""}`}>
      <button className={styles.media} onClick={onOpen} aria-label={`Buka foto dari ${photo.guestName}`}>
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
      <div className={styles.body}>
        <div className={styles.head}>
          <span className={styles.avatar}>
            {photo.guestName.trim()[0]?.toUpperCase()}
          </span>
          <div className={styles.meta}>
            <h3>{photo.guestName}</h3>
            <time dateTime={photo.createdAt}>{timeAgo(photo.createdAt)}</time>
          </div>
        </div>
        {!compact && <p className={styles.wish}>{photo.wishes}</p>}
      </div>
    </article>
  );
}
