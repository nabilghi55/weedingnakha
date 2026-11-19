"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { WifiOff, X } from "lucide-react";
import Navbar from "./Navbar";
import { RevealObserver } from "./Fx";
import { useApp } from "@/context/AppContext";
import { photoSrc, type Photo } from "@/lib/api";
import { BRAND } from "@/lib/brand";
import styles from "./AppShell.module.css";

/** Routes that render full-bleed without navigation (projector wall). */
const BARE_ROUTES = ["/slideshow", "/qr"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // static export uses trailing slashes (/slideshow/), so normalise first
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const bare = BARE_ROUTES.includes(path);

  return (
    <>
      <RevealObserver />
      {!bare && <Navbar />}
      <main className={`app-main ${bare ? "bare" : ""}`}>
        {children}
        {!bare && (
          <footer className={styles.footer}>
            Photobooth oleh <strong>{BRAND.name}</strong> ·{" "}
            <a href={BRAND.instagramUrl} target="_blank" rel="noopener noreferrer">
              {BRAND.instagram}
            </a>
          </footer>
        )}
      </main>
      {!bare && <OfflineBanner />}
      {!bare && <IncomingToast />}
    </>
  );
}

function OfflineBanner() {
  const { status, refresh } = useApp();
  if (status !== "offline") return null;
  return (
    <div className={styles.offline} role="status">
      <WifiOff />
      <span>Server belum terhubung. Data mungkin belum terbaru.</span>
      <button className="btn btn-sm btn-secondary" onClick={() => refresh()}>
        Coba lagi
      </button>
    </div>
  );
}

/** Small toast whenever another guest posts a photo. */
function IncomingToast() {
  const { incoming } = useApp();
  const [toast, setToast] = useState<Photo | null>(null);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    if (!incoming || seen.current === incoming.id) return;
    seen.current = incoming.id;
    setToast(incoming);
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [incoming]);

  if (!toast) return null;
  return (
    <div className={styles.toast} role="status" key={toast.id}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photoSrc(toast.thumbUrl || toast.photoUrl)} alt="" />
      <div>
        <strong>{toast.guestName}</strong>
        <span>baru saja mengirim foto</span>
      </div>
      <button className={styles.toastClose} onClick={() => setToast(null)} aria-label="Tutup">
        <X />
      </button>
    </div>
  );
}
