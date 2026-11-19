// Browser-side helpers for the photobooth guest: a random per-browser device
// ID (no fingerprinting) and a high-accuracy geolocation fix.

import type { LocationFix } from "./api";

const DEVICE_KEY = "nakha_device_id";
let memoryDeviceId = "";

function randomId(bytes = 24) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * A random ID created once and kept in localStorage. It only helps the server
 * recognise the same browser again (for the 5-photo limit); it is hashed
 * server-side and contains nothing about the device itself.
 */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !/^[A-Za-z0-9_-]{16,128}$/.test(id)) {
      id = randomId();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    if (!memoryDeviceId) memoryDeviceId = randomId();
    return memoryDeviceId;
  }
}

export class LocationError extends Error {
  code: "DENIED" | "UNAVAILABLE" | "TIMEOUT" | "UNSUPPORTED";
  constructor(code: LocationError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** A fix older than this is treated as cached (the server rejects > 10 min). */
const MAX_FIX_AGE_MS = 4 * 60 * 1000;

/**
 * Asks for a fresh, high-accuracy position (never a cached one).
 *
 * iOS Safari sometimes answers with CoreLocation's last known position — with
 * its old timestamp — before the GPS has a new fix (typical indoors). That fix
 * is never sent: we keep watching until a fresh one arrives or time runs out.
 */
export function getPosition(timeoutMs = 20000): Promise<LocationFix> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new LocationError("UNSUPPORTED", "Browser ini tidak mendukung deteksi lokasi."));
      return;
    }
    const geo = navigator.geolocation;
    let settled = false;
    let sawStale = false;
    let lastErr: GeolocationPositionError | null = null;
    const watchIds: number[] = [];
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(fallbackTimer);
      watchIds.forEach((id) => geo.clearWatch(id));
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() => {
          if (sawStale || lastErr?.code === lastErr?.TIMEOUT || !lastErr)
            reject(new LocationError("TIMEOUT", "Lokasi terbaru belum terdeteksi. Pastikan GPS aktif, tunggu sebentar, lalu coba lagi."));
          else reject(new LocationError("UNAVAILABLE", "Lokasi tidak dapat ditentukan. Pastikan GPS aktif lalu coba lagi."));
        }),
      timeoutMs,
    );
    const onPos = (pos: GeolocationPosition) => {
      const ts = pos.timestamp || Date.now();
      if (Math.abs(Date.now() - ts) > MAX_FIX_AGE_MS) {
        sawStale = true; // cached fix: keep waiting for a fresh one
        return;
      }
      finish(() =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: ts,
        }),
      );
    };
    const onErr = (err: GeolocationPositionError) => {
      if (err.code === err.PERMISSION_DENIED) {
        finish(() =>
          reject(new LocationError("DENIED", "Izin lokasi ditolak. Aktifkan izin lokasi untuk situs ini di pengaturan browser.")),
        );
        return;
      }
      lastErr = err; // timeout / unavailable: keep watching until our own deadline
    };
    const watch = (highAccuracy: boolean) => {
      if (settled) return;
      try {
        watchIds.push(geo.watchPosition(onPos, onErr, { enableHighAccuracy: highAccuracy, timeout: timeoutMs, maximumAge: 0 }));
      } catch {
        /* ignore */
      }
    };
    watch(true);
    // Indoors the GPS often has no fix yet: after a few seconds also accept the
    // (fresh) network/Wi-Fi position. The server still rejects it if it is
    // less accurate than allowed or outside the venue radius.
    const fallbackTimer = setTimeout(() => watch(false), Math.min(5000, timeoutMs / 3));
  });
}

export const OUTSIDE_AREA_MESSAGE = "Photobooth hanya dapat digunakan di area acara.";
