import type { FilterId } from "./api";
import { drawFiltered } from "./filters";

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Gambar tidak dapat dibaca."));
    img.src = src;
  });
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("File tidak dapat dibaca."));
    reader.readAsDataURL(file);
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/jpeg", quality = 0.86): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Gagal memproses foto."))), type, quality);
  });
}

/**
 * Resizes a photo (max edge `maxEdge`) and bakes the filter into the pixels,
 * so what guests see in the gallery is exactly what they picked.
 */
export async function preparePhoto(src: string, filter: FilterId, maxEdge = 1600): Promise<Blob> {
  const img = await loadImage(src);
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Browser tidak mendukung canvas.");
  drawFiltered(ctx, img, filter, 0, 0, img.width, img.height, 0, 0, w, h);
  return canvasToBlob(canvas);
}
