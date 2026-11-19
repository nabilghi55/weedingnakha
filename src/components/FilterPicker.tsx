"use client";

import type { FilterId } from "@/lib/api";
import { FILTERS, filterById, stampText } from "@/lib/filters";
import styles from "./FilterPicker.module.css";

interface Props {
  imageSrc: string;
  value: FilterId;
  onChange: (f: FilterId) => void;
}

/** Live CSS preview of each filter; the real pixels are baked on upload. */
export function filterStyle(id: FilterId): React.CSSProperties {
  const f = filterById(id);
  return { filter: f.base === "none" ? undefined : f.base };
}

/**
 * Colour wash + disposable-camera effects (grain, vignette, light leak, date stamp)
 * drawn over a live preview. Place inside a positioned parent; canvas output bakes the same look.
 */
export function FilterOverlay({ filter, stamp = true }: { filter: FilterId; stamp?: boolean }) {
  const f = filterById(filter);
  const fx = f.fx;
  return (
    <>
      {f.tint && (
        <span
          className={styles.tint}
          style={{ background: f.tint.color, opacity: f.tint.alpha, mixBlendMode: f.tint.blend as React.CSSProperties["mixBlendMode"] }}
        />
      )}
      {fx?.leak && (
        <span
          className={styles.tint}
          style={{
            background: `radial-gradient(circle at ${fx.leak.x * 100}% ${fx.leak.y * 100}%, ${fx.leak.color}, transparent 75%)`,
            opacity: fx.leak.alpha,
            mixBlendMode: "screen",
          }}
        />
      )}
      {fx?.vignette && (
        <span
          className={styles.tint}
          style={{ background: `radial-gradient(circle, transparent 45%, rgba(0,0,0,${fx.vignette}) 100%)` }}
        />
      )}
      {fx?.grain && <span className={`${styles.tint} ${styles.grain}`} style={{ opacity: fx.grain }} />}
      {fx?.stamp && stamp && <span className={styles.stamp}>{stampText()}</span>}
    </>
  );
}

export function FilteredImage({ src, filter, alt, className }: { src: string; filter: FilterId; alt: string; className?: string }) {
  return (
    <div className={`${styles.filtered} ${className ?? ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} style={filterStyle(filter)} />
      <FilterOverlay filter={filter} stamp={false} />
    </div>
  );
}

export default function FilterPicker({ imageSrc, value, onChange }: Props) {
  return (
    <div className={styles.row} role="radiogroup" aria-label="Filter foto">
      {FILTERS.map((f) => (
        <button
          key={f.id}
          type="button"
          role="radio"
          aria-checked={value === f.id}
          className={`${styles.option} ${value === f.id ? styles.active : ""}`}
          style={{ "--c": f.color } as React.CSSProperties}
          onClick={() => onChange(f.id)}
        >
          <FilteredImage src={imageSrc} filter={f.id} alt="" className={styles.thumb} />
          <span>{f.name}</span>
        </button>
      ))}
    </div>
  );
}
