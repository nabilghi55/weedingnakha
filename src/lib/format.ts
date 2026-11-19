import type { EventType, WeddingEvent } from "./api";

type Named = Pick<WeddingEvent, "groomName" | "brideName"> & { type?: EventType; title?: string };

export const EVENT_TYPES: { id: EventType; name: string; desc: string }[] = [
  { id: "wedding", name: "Pernikahan", desc: "Nama kedua mempelai" },
  { id: "campus", name: "Acara Kampus", desc: "Wisuda, dies natalis, seminar, pensi" },
  { id: "corporate", name: "Acara Perusahaan", desc: "Gathering, launching, anniversary, seminar" },
];

export const isWedding = (ev: Named) => !ev.type || ev.type === "wedding";

/** Display name: "Rian & Salsa" for weddings, the event title otherwise. */
export function eventName(ev: Named) {
  return isWedding(ev) ? `${ev.groomName} & ${ev.brideName}` : ev.title || "Acara";
}

/** Short monogram: "R&S" for weddings, "WU" for "Wisuda UB" otherwise. */
export function eventMonogram(ev: Named) {
  return isWedding(ev) ? `${ev.groomName[0] ?? ""}&${ev.brideName[0] ?? ""}` : initials(ev.title || "Acara");
}

export function eventTypeName(ev: Named) {
  return EVENT_TYPES.find((t) => t.id === (ev.type ?? "wedding"))?.name ?? "Acara";
}

/** Small kicker above the event name, in the same voice as "The Wedding Of". */
export function eventKicker(ev: Named) {
  return { wedding: "THE WEDDING OF", campus: "CELEBRATING", corporate: "WELCOME TO" }[ev.type ?? "wedding"] ?? "THE WEDDING OF";
}

/** Share caption for a photo. */
export function momentCaption(ev: Named) {
  return isWedding(ev) ? `Momen bahagia di pernikahan ${eventName(ev)}` : `Momen seru di ${eventName(ev)}`;
}

export function eventDateTime(ev: WeddingEvent): Date {
  return new Date(`${ev.eventDate}T${ev.eventTime || "00:00"}:00`);
}

export function formatLongDate(ev: WeddingEvent) {
  return eventDateTime(ev).toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function formatShortDate(ev: WeddingEvent) {
  const d = eventDateTime(ev);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd} · ${mm} · ${d.getFullYear()}`;
}

export function timeAgo(iso: string) {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return "baru saja";
  if (m < 60) return `${m} menit lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  return new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
}

export function clockTime(iso: string) {
  return new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

export function googleCalendarUrl(ev: WeddingEvent) {
  const start = eventDateTime(ev);
  const end = new Date(start.getTime() + 3 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: isWedding(ev) ? `Pernikahan ${eventName(ev)}` : eventName(ev),
    dates: `${fmt(start)}/${fmt(end)}`,
    location: [ev.venue, ev.venueAddress].filter(Boolean).join(", "),
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

export function initials(name: string) {
  return name
    .split(/[\s&]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}
