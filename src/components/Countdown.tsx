"use client";

import { useEffect, useState } from "react";
import styles from "./Countdown.module.css";

function diff(target: number) {
  const ms = Math.max(0, target - Date.now());
  return {
    done: ms === 0,
    parts: [
      { label: "Hari", value: Math.floor(ms / 86400000) },
      { label: "Jam", value: Math.floor((ms % 86400000) / 3600000) },
      { label: "Menit", value: Math.floor((ms % 3600000) / 60000) },
      { label: "Detik", value: Math.floor((ms % 60000) / 1000) },
    ],
  };
}

export default function Countdown({ target }: { target: Date }) {
  const t = target.getTime();
  const [state, setState] = useState<ReturnType<typeof diff> | null>(null);

  useEffect(() => {
    const tick = () => setState(diff(t));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [t]);

  if (state?.done) {
    return (
      <div className={styles.live}>
        <span className="live-dot" /> Acara sedang berlangsung
      </div>
    );
  }

  return (
    <div className={styles.grid} aria-label="Hitung mundur acara">
      {(state?.parts ?? diff(t).parts.map((p) => ({ ...p, value: 0 }))).map((p) => (
        <div key={p.label} className={styles.item}>
          <span className={styles.value}>{String(p.value).padStart(2, "0")}</span>
          <span className={styles.label}>{p.label}</span>
        </div>
      ))}
    </div>
  );
}
