// Typed client for the Go backend (see /backend).
//
// Authentication is cookie based (HttpOnly sessions set by the API); the
// browser never sees host tokens after the first exchange, never sees
// storage credentials, and never chooses event IDs, object keys or quotas.

export type ThemeId = "maroon" | "sage" | "terracotta" | "navy";
/** Camera filters guests can pick; the legacy ids only appear on older photos. */
export type FilterId =
  | "none"
  | "bw"
  | "classic"
  | "vintage"
  | "softflash"
  | "goldenhour"
  | "rose"
  | "pastel"
  | "cool"
  | "moody"
  | "noir"
  // disposable-camera looks
  | "disposable"
  | "nightflash"
  | "film400"
  | "lightleak"
  | "disposablebw"
  | "instant"
  | "expired"
  | "crossprocess"
  | "faded"
  // legacy
  | "warm"
  | "film"
  | "mono"
  | "soft";
export type EventStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "ENDED";
export type ModerationMode = "AUTO_PUBLISH" | "MANUAL_APPROVAL";
export type GalleryVisibility = "PUBLIC" | "GUESTS" | "PRIVATE";

export type EventType = "wedding" | "campus" | "corporate";

/** Public invitation data (no coordinates, tokens or internal IDs). */
/** Most custom photobooth frames per event. */
export const MAX_FRAMES = 4;

export interface EventFrame {
  id: string;
  url: string;
}

/** The event's frames, also for servers that only send `frameUrl`. */
export function eventFrames(ev: { frameUrl: string; frames?: EventFrame[] }): EventFrame[] {
  if (ev.frames?.length) return ev.frames;
  return ev.frameUrl ? [{ id: "legacy", url: ev.frameUrl }] : [];
}

export interface WeddingEvent {
  /**
   * How the public API picked this event: "slug" (link/QR), "guest" (checked-in)
   * or "default" (no context → show only the studio brand). Absent on host/admin data.
   */
  scope?: "slug" | "guest" | "default";
  slug: string;
  /** wedding: titled by groomName & brideName; other types: by title */
  type: EventType;
  title: string;
  groomName: string;
  brideName: string;
  groomParent: string;
  brideParent: string;
  eventDate: string; // YYYY-MM-DD (event timezone)
  eventTime: string; // HH:MM
  endTime: string;
  venue: string;
  venueAddress: string;
  mapsUrl: string;
  hashtag: string;
  theme: ThemeId;
  coverUrl: string;
  /** first custom photobooth frame, "" when none (older servers only send this) */
  frameUrl: string;
  /** the event's custom photobooth frames (transparent PNGs), at most MAX_FRAMES */
  frames?: EventFrame[];
  status: EventStatus;
  photoboothOpen: boolean;
  galleryVisibility: GalleryVisibility;
  maxPhotosPerGuest: number;
}

export interface BoothState {
  open: boolean;
  code?: string;
  message?: string;
  opensAt: string;
  closesAt: string;
}

/** What the event's host (and admins) can see. */
export interface PrivateEvent extends WeddingEvent {
  id: string;
  startAt: string;
  endAt: string;
  venueLatitude: number | null;
  venueLongitude: number | null;
  radiusMeters: number;
  moderationMode: ModerationMode;
  booth: BoothState;
}

export interface AdminEvent extends PrivateEvent {
  hostTokenActive: boolean;
  hostTokenIssuedAt?: string;
  hostTokenRevokedAt?: string;
  isDefault: boolean;
}

export interface Photo {
  id: string;
  guestName: string;
  wishes: string;
  filter: FilterId;
  /** "photobooth" = framed collage, "moment" = plain photo; "upload" on old photos */
  source: "upload" | "photobooth" | "moment";
  likes: number;
  createdAt: string;
  width?: number;
  height?: number;
  /** Short-lived signed URL (empty while still processing). */
  photoUrl: string;
  thumbUrl: string;
  // host/admin only
  status?: "PROCESSING" | "READY" | "FAILED";
  approval?: "APPROVED" | "PENDING";
  hiddenFromWall?: boolean;
  hiddenFromGallery?: boolean;
  /** host/admin only: signed link to the copy without the studio watermark */
  downloadUrl?: string;
}

export interface GalleryStats {
  photos: number;
  guests: number;
  likes: number;
}

export interface EventStats {
  totalPhotos: number;
  pendingApproval: number;
  processing: number;
  hidden: number;
  totalGuests: number;
  guestsUploaded: number;
  totalLikes: number;
  lastHour: number;
  liveViewers: number;
  maxPhotosPerGuest: number;
}

export interface GuestSession {
  event: WeddingEvent;
  booth: BoothState;
  uploadedCount: number;
  reservedCount: number;
  maxPhotos: number;
  remaining: number;
  locationValidUntil: string;
  /** false when the deployment has location checks switched off */
  locationRequired?: boolean;
  expiresAt: string;
}

/** Printable check-in QR: fixed per event until rotated; only works while the booth is open. */
export interface QrInfo {
  token: string;
  url: string;
  boothOpen: boolean;
  opensAt: string;
  closesAt: string;
  refreshAfterMs: number;
}

export interface LocationFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
}

export interface PresignedUpload {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface AuditEntry {
  id: string;
  actorType: string;
  actorId: string;
  eventId?: string;
  action: string;
  targetId?: string;
  metadata?: Record<string, string>;
  createdAt: string;
}

export interface EventInput {
  slug?: string;
  status?: EventStatus;
  type: EventType;
  title: string;
  groomName: string;
  brideName: string;
  groomParent: string;
  brideParent: string;
  venue: string;
  venueAddress: string;
  mapsUrl: string;
  hashtag: string;
  theme: ThemeId;
  startAt: string;
  endAt: string;
  venueLatitude?: number | null;
  venueLongitude?: number | null;
  radiusMeters?: number;
  moderationMode?: ModerationMode;
  galleryVisibility?: GalleryVisibility;
}

export interface HostSettingsInput {
  moderationMode?: ModerationMode;
  galleryVisibility?: GalleryVisibility;
  radiusMeters?: number;
  venueLatitude?: number;
  venueLongitude?: number;
}

export type ModerationAction = "hide" | "restore" | "approve";
export type ModerationTarget = "wall" | "gallery" | "both";

export type StreamMessage =
  | { type: "photo.published"; data: { id: string } }
  | { type: "photo.removed"; data: { id: string; from?: "wall" | "gallery" | "both" } }
  | { type: "photos.changed"; data: Record<string, never> }
  | { type: "photo.liked"; data: { id: string; likes: number } }
  | { type: "event.updated"; data: Record<string, never> };

export const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

export const DEFAULT_EVENT: WeddingEvent = {
  scope: "default",
  slug: "",
  type: "wedding",
  title: "",
  groomName: "Rian",
  brideName: "Salsa",
  groomParent: "",
  brideParent: "",
  eventDate: "2026-12-12",
  eventTime: "10:00",
  endTime: "",
  venue: "",
  venueAddress: "",
  mapsUrl: "",
  hashtag: "",
  theme: "maroon",
  coverUrl: "",
  frameUrl: "",
  frames: [],
  status: "DRAFT",
  photoboothOpen: false,
  galleryVisibility: "GUESTS",
  maxPhotosPerGuest: 5,
};

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** API-relative media (signed photo URLs, cover) is served by the Go API. */
export function photoSrc(url: string) {
  return url.startsWith("/api/") ? `${API_BASE}${url}` : url;
}

/**
 * Secret admin URL segment (/<ADMIN_PATH>/), read from the address bar by the
 * admin page. The API hides every /api/admin/* endpoint (404) without it.
 */
let adminKey = "";
export function setAdminKey(key: string) {
  adminKey = key;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  // custom header = CSRF guard (forces a CORS preflight cross-origin)
  headers.set("X-Nakha-Request", "1");
  if (adminKey && path.startsWith("/api/admin/")) headers.set("X-Nakha-Admin-Key", adminKey);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store", credentials: "include" });
  } catch {
    throw new ApiError("Tidak dapat terhubung ke server. Periksa koneksi internet Anda.", 0, "NETWORK");
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Terjadi kesalahan (${res.status}).`, res.status, body.code ?? "");
  return body as T;
}

/** Admin ZIP of all photos without watermark (needs the admin key header, so fetched as a blob). */
export async function downloadAdminZip(eventId: string): Promise<Blob> {
  const headers = new Headers({ "X-Nakha-Request": "1" });
  if (adminKey) headers.set("X-Nakha-Admin-Key", adminKey);
  const res = await fetch(`${API_BASE}/api/admin/events/${eventId}/photos/download`, { headers, credentials: "include", cache: "no-store" });
  if (!res.ok) throw new ApiError(`Gagal mengunduh (${res.status}).`, res.status, "");
  return res.blob();
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

const q = (slug?: string) => (slug ? `?slug=${encodeURIComponent(slug)}` : "");

export const api = {
  // ---- public ----
  getEvent: (slug?: string) => request<WeddingEvent>(`/api/public/event${q(slug)}`),
  /** One page of the gallery (newest first); `before` = last photo id of the previous page. */
  getGallery: (slug?: string, opts: { limit?: number; before?: string } = {}) => {
    const p = new URLSearchParams();
    if (slug) p.set("slug", slug);
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.before) p.set("before", opts.before);
    const qs = p.toString();
    return request<{ photos: Photo[]; hasMore: boolean; stats: GalleryStats; event: WeddingEvent }>(`/api/gallery/photos${qs ? `?${qs}` : ""}`);
  },
  /** A single gallery photo (used to add newly published photos without reloading everything). */
  getPhoto: (id: string) => request<Photo>(`/api/gallery/photos/${encodeURIComponent(id)}`),
  likePhoto: (id: string, undo = false) =>
    request<{ id: string; likes: number }>(`/api/gallery/photos/${id}/like${undo ? "?undo=1" : ""}`, { method: "POST" }),

  // ---- guest (photobooth) ----
  guest: {
    checkin: (input: { qr: string; deviceId: string } & Partial<LocationFix>) =>
      request<GuestSession>("/api/guest/checkin", json("POST", input)),
    session: () => request<GuestSession>("/api/guest/session"),
    location: (fix: LocationFix) => request<GuestSession>("/api/guest/location", json("POST", fix)),
    authorize: (input: {
      guestName: string;
      wishes: string;
      filter: FilterId;
      mode?: "photobooth" | "moment";
      contentType: string;
      size: number;
      location?: LocationFix;
    }) =>
      request<{ reservationId: string; upload: PresignedUpload; expiresAt: string; session: GuestSession }>(
        "/api/guest/upload/authorize",
        json("POST", input),
      ),
    complete: (reservationId: string) =>
      request<{
        photo: { id: string; status: string; approval: "APPROVED" | "PENDING" };
        moderationMode: ModerationMode;
        session: GuestSession;
      }>("/api/guest/upload/complete", json("POST", { reservationId })),
    cancel: (reservationId: string) => request<GuestSession>("/api/guest/upload/cancel", json("POST", { reservationId })),
  },

  // ---- host (customer) ----
  host: {
    me: () => request<PrivateEvent>("/api/host/me"),
    logout: () => request<void>("/api/host/logout", { method: "POST" }),
    stats: () => request<EventStats>("/api/host/stats"),
    photos: () => request<{ photos: Photo[] }>("/api/host/photos"),
    moderate: (id: string, action: ModerationAction, target: ModerationTarget = "both") =>
      request<Photo>(`/api/host/photos/${id}/${action}`, json("POST", { target })),
    deletePhoto: (id: string) => request<void>(`/api/host/photos/${id}`, { method: "DELETE" }),
    pause: () => request<PrivateEvent>("/api/host/event/pause", { method: "POST" }),
    resume: () => request<PrivateEvent>("/api/host/event/resume", { method: "POST" }),
    settings: (input: HostSettingsInput) => request<PrivateEvent>("/api/host/event/settings", json("PUT", input)),
    qr: () => request<QrInfo>("/api/host/qr"),
    rotateQr: () => request<{ qrVersion: number }>("/api/host/qr/rotate", { method: "POST" }),
    displayLink: () => request<{ url: string }>("/api/host/display-link"),
    rotateDisplayLink: () => request<{ url: string }>("/api/host/display-link/rotate", { method: "POST" }),
  },

  // ---- display (Live Wall) ----
  display: {
    session: (k: string) => request<{ ok: boolean }>("/api/display/session", json("POST", { k })),
    event: () => request<WeddingEvent>("/api/display/event"),
    photos: () => request<{ photos: Photo[] }>("/api/display/photos"),
    qr: () => request<QrInfo>("/api/display/qr"),
  },

  // ---- admin ----
  admin: {
    login: (pin: string) => request<{ ok: boolean; expiresAt: string }>("/api/admin/login", json("POST", { pin })),
    logout: () => request<void>("/api/admin/logout", { method: "POST" }),
    me: () => request<{ ok: boolean }>("/api/admin/me"),
    events: () => request<AdminEvent[]>("/api/admin/events"),
    createEvent: (input: EventInput) =>
      request<{ event: AdminEvent; hostToken: string; hostAccessUrl: string }>("/api/admin/events", json("POST", input)),
    updateEvent: (id: string, input: EventInput) => request<AdminEvent>(`/api/admin/events/${id}`, json("PUT", input)),
    setDefault: (id: string) => request<AdminEvent>(`/api/admin/events/${id}/default`, { method: "POST" }),
    regenerateHostToken: (id: string) =>
      request<{ event: AdminEvent; hostToken: string; hostAccessUrl: string }>(`/api/admin/events/${id}/host-token`, {
        method: "POST",
      }),
    revokeHostToken: (id: string) => request<AdminEvent>(`/api/admin/events/${id}/host-token`, { method: "DELETE" }),
    uploadCover: (id: string, photo: Blob) => {
      const form = new FormData();
      form.append("photo", photo, "cover.jpg");
      return request<AdminEvent>(`/api/admin/events/${id}/cover`, { method: "POST", body: form });
    },
    deleteCover: (id: string) => request<AdminEvent>(`/api/admin/events/${id}/cover`, { method: "DELETE" }),
    uploadFrame: (id: string, frame: Blob) => {
      const form = new FormData();
      form.append("frame", frame, "frame.png");
      return request<AdminEvent>(`/api/admin/events/${id}/frame`, { method: "POST", body: form });
    },
    deleteFrame: (id: string, frameId: string) =>
      request<AdminEvent>(`/api/admin/events/${id}/frames/${encodeURIComponent(frameId)}`, { method: "DELETE" }),
    photos: (id: string) => request<{ photos: Photo[] }>(`/api/admin/events/${id}/photos`),
    moderate: (id: string, photoId: string, action: ModerationAction, target: ModerationTarget = "both") =>
      request<Photo>(`/api/admin/events/${id}/photos/${photoId}/${action}`, json("POST", { target })),
    deletePhoto: (id: string, photoId: string) =>
      request<void>(`/api/admin/events/${id}/photos/${photoId}`, { method: "DELETE" }),
    stats: (id: string) => request<EventStats>(`/api/admin/events/${id}/stats`),
    qr: (id: string) => request<QrInfo>(`/api/admin/events/${id}/qr`),
    rotateQr: (id: string) => request<{ qrVersion: number }>(`/api/admin/events/${id}/qr/rotate`, { method: "POST" }),
    displayLink: (id: string) => request<{ url: string }>(`/api/admin/events/${id}/display-link`),
    rotateDisplayLink: (id: string) =>
      request<{ url: string }>(`/api/admin/events/${id}/display-link/rotate`, { method: "POST" }),
    audit: (eventId?: string) =>
      request<AuditEntry[]>(`/api/admin/audit${eventId ? `?eventId=${encodeURIComponent(eventId)}` : ""}`),
  },
};

/**
 * PUT the photo to the presigned URL the API issued (R2/S3 or the local
 * dev driver). XHR is used because fetch has no upload progress events.
 */
export function putFile(upload: PresignedUpload, blob: Blob, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = upload.url.startsWith("/") ? `${API_BASE}${upload.url}` : upload.url;
    xhr.open(upload.method || "PUT", url);
    for (const [k, v] of Object.entries(upload.headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new ApiError(`Upload gagal (${xhr.status}). Coba lagi.`, xhr.status, "UPLOAD_FAILED"));
    xhr.onerror = () => reject(new ApiError("Koneksi terputus saat mengunggah. Coba lagi.", 0, "NETWORK"));
    xhr.send(blob);
  });
}

/** Opens the realtime stream for a scope; the API derives the event from the caller's credential. */
export function openStream(scope: "gallery" | "wall" | "host", slug?: string) {
  const params = new URLSearchParams({ scope });
  if (slug) params.set("slug", slug);
  return new EventSource(`${API_BASE}/api/stream?${params}`, { withCredentials: true });
}
