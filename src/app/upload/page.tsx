"use client";

import Link from "next/link";
import { Camera, Images, QrCode } from "lucide-react";
import { useApp } from "@/context/AppContext";
import styles from "./upload.module.css";
import { eventName } from "@/lib/format";

/**
 * The old open upload route. Uploading from here is disabled on purpose:
 * photos can only be sent from the photobooth, at the venue, during the
 * event. There is no file picker and no upload call on this page.
 */
export default function UploadInfoPage() {
  const { event, eventScoped } = useApp();
  const steps = [
    { icon: QrCode, text: "Scan QR photobooth yang tampil di lokasi acara." },
    { icon: Camera, text: `Ambil foto langsung dari kamera, pilih bingkai & filter, lalu kirim (maks. ${event.maxPhotosPerGuest} kolase photobooth${event.maxMomentsPerGuest ? ` + ${event.maxMomentsPerGuest} foto momen` : ""} per HP).` },
  ];

  return (
    <div className="page">
      <div className="container-narrow">
        <div className={`card card-feature card-pad ${styles.success} fade-up`}>
          <span className={styles.successIcon}>
            <Camera />
          </span>
          <h1>Kirim foto lewat Photobooth</h1>
          <p className="muted">
            Untuk menjaga galeri {eventScoped ? eventName(event) : "acara"} tetap aman, foto hanya dapat dikirim melalui
            Photobooth di lokasi acara.
          </p>
          <ol style={{ display: "grid", gap: 12, textAlign: "left", margin: "8px 0 4px", padding: 0, listStyle: "none" }}>
            {steps.map((s, i) => (
              <li key={i} className="alert alert-info">
                <s.icon /> {s.text}
              </li>
            ))}
          </ol>
          <div className={styles.successActions}>
            <Link href="/photobooth" className="btn btn-primary">
              <Camera /> Buka Photobooth
            </Link>
            <Link href="/gallery" className="btn btn-secondary">
              <Images /> Lihat Galeri
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
