"use client";

import { useEffect, useState } from "react";
import QR from "qrcode";

interface Props {
  value: string;
  size?: number;
  dark?: string;
  light?: string;
  className?: string;
  onReady?: (dataUrl: string) => void;
}

/** QR code rendered locally (no third-party QR service). */
export default function QRCode({ value, size = 220, dark = "#1c0507", light = "#ffffff", className, onReady }: Props) {
  const [src, setSrc] = useState<string>("");

  useEffect(() => {
    let alive = true;
    QR.toDataURL(value, { width: size * 2, margin: 1, errorCorrectionLevel: "M", color: { dark, light } })
      .then((url) => {
        if (!alive) return;
        setSrc(url);
        onReady?.(url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [value, size, dark, light, onReady]);

  if (!src) return <div className={className} style={{ width: size, height: size }} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} width={size} height={size} alt={`QR code ke ${value}`} className={className} />;
}
