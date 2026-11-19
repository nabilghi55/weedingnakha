"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, DEFAULT_EVENT, openStream, type GalleryStats, type Photo, type StreamMessage, type WeddingEvent } from "@/lib/api";

type Status = "loading" | "ready" | "offline";
/** Whether this browser may read the current event's gallery (server decides). */
export type GalleryAccess = "unknown" | "granted" | "denied";

interface AppContextType {
  event: WeddingEvent;
  /**
   * False while the site only knows the server's default event (visitor has not
   * scanned a QR or opened an event link): pages then show the studio brand,
   * not that couple's names or theme.
   */
  eventScoped: boolean;
  photos: Photo[];
  status: Status;
  galleryAccess: GalleryAccess;
  /** Most recent photo published by the server (used for toasts). */
  incoming: Photo | null;
  likedIds: Set<string>;
  toggleLike: (id: string) => void;
  /** Apply an event's theme/names (e.g. host or Live Wall pages). */
  setEvent: (ev: WeddingEvent) => void;
  /** Switch the public pages to another event (e.g. after photobooth check-in). */
  setSlug: (slug: string) => void;
  refresh: () => Promise<void>;
  /** Server-side totals (the list itself is paginated). */
  galleryStats: GalleryStats;
  hasMore: boolean;
  loadMore: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

const LIKES_KEY = "nakha_liked";
const SLUG_KEY = "nakha_event";
// Signed photo URLs live 15 minutes on the server; refresh well before.
const URL_REFRESH_MS = 10 * 60 * 1000;
// Gallery pages: first page size, and the most a refresh re-requests at once.
const PAGE = 60;
const MAX_RELOAD = 300;
/** Random delay so hundreds of phones don't hit the server in the same second. */
const jitter = (ms: number) => Math.round(Math.random() * ms);

function readLiked(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(LIKES_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** True when the slug came from an explicit ?e=… link on this page load. */
let slugFromUrl = false;

/** Event slug from ?e=… (remembered), or the last one used on this browser. */
function readSlug(): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("e");
    if (fromUrl && /^[a-z0-9-]{1,60}$/.test(fromUrl)) {
      localStorage.setItem(SLUG_KEY, fromUrl);
      slugFromUrl = true;
      return fromUrl;
    }
    return localStorage.getItem(SLUG_KEY) ?? "";
  } catch {
    return "";
  }
}

/** A remembered event is forgotten this long after it ended. */
const REMEMBER_AFTER_END_MS = 3 * 24 * 60 * 60 * 1000;

function endedLongAgo(ev: WeddingEvent) {
  const end = new Date(`${ev.eventDate}T${ev.endTime || ev.eventTime || "23:59"}:00`);
  return !Number.isNaN(end.getTime()) && Date.now() - end.getTime() > REMEMBER_AFTER_END_MS;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [event, setEventState] = useState<WeddingEvent>(DEFAULT_EVENT);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [galleryAccess, setGalleryAccess] = useState<GalleryAccess>("unknown");
  const [incoming, setIncoming] = useState<Photo | null>(null);
  const [likedIds, setLikedIds] = useState<Set<string>>(() => new Set());
  const [slug, setSlugState] = useState<string | null>(null);
  const [galleryStats, setGalleryStats] = useState<GalleryStats>({ photos: 0, guests: 0, likes: 0 });
  const [hasMore, setHasMore] = useState(false);
  const loadedRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const applyEvent = useCallback((ev: WeddingEvent) => {
    setEventState(ev);
    // without an event context the studio's own maroon look is used
    document.documentElement.setAttribute("data-theme", ev.scope === "default" ? "maroon" : ev.theme);
  }, []);
  const eventScoped = event.scope !== "default";

  /** Loads event + gallery and returns the photo list (null on failure). */
  const load = useCallback(async (): Promise<Photo[] | null> => {
    if (slug === null) return null;
    try {
      const ev = await api.getEvent(slug || undefined);
      // an event remembered from an old visit (not an explicit ?e= link) stops
      // following this browser a few days after it ended → back to the brand page
      if (slug && ev.scope === "slug" && !slugFromUrl && endedLongAgo(ev)) {
        try {
          localStorage.removeItem(SLUG_KEY);
        } catch {
          /* ignore */
        }
        setSlugState("");
        return null;
      }
      applyEvent(ev);
      let list: Photo[] = [];
      try {
        // re-request what is already shown (fresh signed URLs), within limits
        const res = await api.getGallery(ev.slug, { limit: Math.min(MAX_RELOAD, Math.max(PAGE, loadedRef.current)) });
        list = res.photos;
        loadedRef.current = list.length;
        setHasMore(res.hasMore);
        setGalleryStats(res.stats);
        setGalleryAccess("granted");
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 401)) setGalleryAccess("denied");
        else throw err;
      }
      setPhotos(list);
      setStatus("ready");
      return list;
    } catch (err) {
      // 404 for a remembered slug: that event no longer exists → forget it and
      // fall back to the current default event
      if (err instanceof ApiError && err.status === 404 && slug) {
        try {
          localStorage.removeItem(SLUG_KEY);
        } catch {
          /* ignore */
        }
        setSlugState("");
        return null;
      }
      // 404 without a slug = no event published yet (e.g. right after a reset): the server is up
      if (err instanceof ApiError && err.status === 404) {
        setPhotos([]);
        setGalleryAccess("denied");
        setStatus("ready");
        return [];
      }
      setStatus("offline");
      return null;
    }
  }, [slug, applyEvent]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  /** Appends the next (older) page of the gallery. */
  const loadMore = useCallback(async () => {
    const last = photos[photos.length - 1];
    if (!last || !hasMore) return;
    try {
      const res = await api.getGallery(event.slug || slug || undefined, { limit: PAGE, before: last.id });
      setPhotos((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const next = [...prev, ...res.photos.filter((p) => !seen.has(p.id))];
        loadedRef.current = next.length;
        return next;
      });
      setHasMore(res.hasMore);
      setGalleryStats(res.stats);
    } catch {
      /* keep what is shown */
    }
  }, [photos, hasMore, event.slug, slug]);

  // resolve the slug once on the client
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only storage read on mount
    setLikedIds(readLiked());
    setSlugState(readSlug());
  }, []);

  const setSlug = useCallback((s: string) => {
    try {
      localStorage.setItem(SLUG_KEY, s);
    } catch {
      /* ignore */
    }
    setSlugState(s);
  }, []);

  // Initial load + realtime stream (with a polling fallback when SSE drops).
  // Load whenever the event changes; refresh periodically to renew signed URLs.
  useEffect(() => {
    if (slug === null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch for the resolved event
    refresh();
    const urlTimer = setInterval(refresh, URL_REFRESH_MS + jitter(60000));
    return () => clearInterval(urlTimer);
  }, [slug, refresh]);

  // Realtime stream, only once the server granted gallery access.
  useEffect(() => {
    if (slug === null || galleryAccess !== "granted") return;

    let debounce: ReturnType<typeof setTimeout> | null = null;
    // rare full reload (event settings changed); jittered so phones don't stampede
    const scheduleRefresh = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void load(), 500 + jitter(5000));
    };
    // a new photo: fetch just that one and put it on top
    const addPhoto = async (id: string) => {
      await new Promise((r) => setTimeout(r, jitter(1500)));
      try {
        const p = await api.getPhoto(id);
        let added = false;
        setPhotos((prev) => {
          if (prev.some((x) => x.id === p.id)) return prev;
          added = true;
          loadedRef.current = prev.length + 1;
          return [p, ...prev];
        });
        if (added) setGalleryStats((s) => ({ ...s, photos: s.photos + 1 }));
        setIncoming(p);
      } catch {
        /* hidden again / not visible to this viewer */
      }
    };

    const es = openStream("gallery", event.slug || slug || undefined);
    const stopPolling = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
    es.onopen = stopPolling;
    es.onerror = () => {
      if (!pollRef.current) pollRef.current = setInterval(refresh, 15000);
    };
    es.onmessage = (e) => {
      let msg: StreamMessage;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "photo.published":
          void addPhoto(msg.data.id);
          break;
        case "photo.removed":
          if (msg.data.from === "wall") break; // only hidden on the Live Wall
          // removed from the gallery (hidden/deleted), whether or not that page is loaded
          setPhotos((prev) => prev.filter((p) => p.id !== msg.data.id));
          setGalleryStats((s) => ({ ...s, photos: Math.max(0, s.photos - 1) }));
          break;
        case "photo.liked":
          setPhotos((prev) => prev.map((p) => (p.id === msg.data.id ? { ...p, likes: msg.data.likes } : p)));
          break;
        // "photos.changed" (processing / moderation bookkeeping) is for the host
        // dashboard; the gallery gets photo.published / photo.removed instead
        case "event.updated":
          scheduleRefresh();
          break;
      }
    };
    return () => {
      es.close();
      stopPolling();
      if (debounce) clearTimeout(debounce);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect only when the event or access changes
  }, [slug, galleryAccess, event.slug]);

  const likedRef = useRef(likedIds);
  useEffect(() => {
    likedRef.current = likedIds;
  }, [likedIds]);

  const toggleLike = useCallback((id: string) => {
    const next = new Set(likedRef.current);
    const undo = next.has(id);
    if (undo) next.delete(id);
    else next.add(id);
    likedRef.current = next;
    setLikedIds(next);
    try {
      localStorage.setItem(LIKES_KEY, JSON.stringify([...next]));
    } catch {
      /* storage unavailable: likes still count server-side */
    }
    setPhotos((ps) => ps.map((p) => (p.id === id ? { ...p, likes: Math.max(0, p.likes + (undo ? -1 : 1)) } : p)));
    api.likePhoto(id, undo).catch(() => undefined);
  }, []);

  const value = useMemo(
    () => ({
      event,
      eventScoped,
      photos,
      status,
      galleryAccess,
      incoming,
      likedIds,
      toggleLike,
      setEvent: applyEvent,
      setSlug,
      refresh,
      galleryStats,
      hasMore,
      loadMore,
    }),
    [event, eventScoped, photos, status, galleryAccess, incoming, likedIds, toggleLike, applyEvent, setSlug, refresh, galleryStats, hasMore, loadMore],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within an AppProvider");
  return ctx;
}
