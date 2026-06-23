"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

export interface WeddingPhoto {
  id: string;
  guestName: string;
  wishes: string;
  photoUrl: string; // base64 or public path
  filter: string; // e.g., 'neon-pink', 'neon-cyan', 'neon-gold', 'neon-green', 'none'
  timestamp: string;
}

export type NeonTheme = "pink-cyber" | "cyan-future" | "gold-luxury" | "acid-lime";

interface AppContextType {
  groomName: string;
  brideName: string;
  eventDate: string;
  neonTheme: NeonTheme;
  photos: WeddingPhoto[];
  addPhoto: (guestName: string, wishes: string, photoUrl: string, filter: string) => void;
  deletePhoto: (id: string) => void;
  updateEventDetails: (groom: string, bride: string, date: string) => void;
  updateTheme: (theme: NeonTheme) => void;
  resetToDefault: () => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

const DEFAULT_PHOTOS: WeddingPhoto[] = [
  {
    id: "demo-1",
    guestName: "Aditya & Rara",
    wishes: "Happy wedding Rian & Salsa! Semoga sakinah mawaddah warahmah, pestanya seru banget ala neon begini! ✨🎉",
    photoUrl: "/images/couple.png",
    filter: "neon-pink",
    timestamp: "10:32"
  },
  {
    id: "demo-2",
    guestName: "Budi Santoso",
    wishes: "Happy wedding bro Rian! Akhirnya sah juga ya. Langgeng terus sampai kakek nenek! 🙏🥂",
    photoUrl: "/images/rings.png",
    filter: "neon-gold",
    timestamp: "10:45"
  },
  {
    id: "demo-3",
    guestName: "Gen Z Squad",
    wishes: "Wedding tergokil tahun ini! Konsep neonnya pecah abis! 🔥🕺💃",
    photoUrl: "/images/guests.png",
    filter: "neon-cyan",
    timestamp: "11:02"
  }
];

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [groomName, setGroomName] = useState("Rian");
  const [brideName, setBrideName] = useState("Salsa");
  const [eventDate, setEventDate] = useState("2026-08-08");
  const [neonTheme, setNeonTheme] = useState<NeonTheme>("pink-cyber");
  const [photos, setPhotos] = useState<WeddingPhoto[]>([]);
  const [initialized, setInitialized] = useState(false);

  // Load from localStorage on client side
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const urlGroom = params.get("groom");
      const urlBride = params.get("bride");
      const urlDate = params.get("date");
      const urlTheme = params.get("theme") as NeonTheme | null;

      const activeGroom = urlGroom || localStorage.getItem("neon_groom") || "Rian";
      const activeBride = urlBride || localStorage.getItem("neon_bride") || "Salsa";
      const activeDate = urlDate || localStorage.getItem("neon_date") || "2026-08-08";
      const activeTheme = urlTheme || (localStorage.getItem("neon_theme") as NeonTheme) || "pink-cyber";

      if (urlGroom) localStorage.setItem("neon_groom", urlGroom);
      if (urlBride) localStorage.setItem("neon_bride", urlBride);
      if (urlDate) localStorage.setItem("neon_date", urlDate);
      if (urlTheme) localStorage.setItem("neon_theme", urlTheme);

      setGroomName(activeGroom);
      setBrideName(activeBride);
      setEventDate(activeDate);
      setNeonTheme(activeTheme);
      document.documentElement.setAttribute("data-theme", activeTheme);
      
      const photosKey = `neon_photos_${activeGroom.toLowerCase()}_${activeBride.toLowerCase()}`;
      const storedPhotos = localStorage.getItem(photosKey);
      
      if (storedPhotos) {
        setPhotos(JSON.parse(storedPhotos));
      } else {
        setPhotos(DEFAULT_PHOTOS);
        localStorage.setItem(photosKey, JSON.stringify(DEFAULT_PHOTOS));
      }
      setInitialized(true);
    }
  }, []);

  // Sync theme changes to html element attribute
  const updateTheme = useCallback((theme: NeonTheme) => {
    setNeonTheme(theme);
    localStorage.setItem("neon_theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, []);

  const updateEventDetails = useCallback((groom: string, bride: string, date: string) => {
    setGroomName(groom);
    setBrideName(bride);
    setEventDate(date);
    localStorage.setItem("neon_groom", groom);
    localStorage.setItem("neon_bride", bride);
    localStorage.setItem("neon_date", date);

    const photosKey = `neon_photos_${groom.toLowerCase()}_${bride.toLowerCase()}`;
    const storedPhotos = localStorage.getItem(photosKey);
    if (storedPhotos) {
      setPhotos(JSON.parse(storedPhotos));
    } else {
      setPhotos(DEFAULT_PHOTOS);
      localStorage.setItem(photosKey, JSON.stringify(DEFAULT_PHOTOS));
    }
  }, []);

  const addPhoto = useCallback((guestName: string, wishes: string, photoUrl: string, filter: string) => {
    const now = new Date();
    const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    
    const newPhoto: WeddingPhoto = {
      id: `photo-${Date.now()}`,
      guestName: guestName || "Guest",
      wishes: wishes || "Selamat menempuh hidup baru!",
      photoUrl,
      filter,
      timestamp: timeString
    };

    setPhotos((prev) => {
      const updated = [newPhoto, ...prev];
      const photosKey = `neon_photos_${groomName.toLowerCase()}_${brideName.toLowerCase()}`;
      localStorage.setItem(photosKey, JSON.stringify(updated));
      return updated;
    });
  }, [groomName, brideName]);

  const deletePhoto = useCallback((id: string) => {
    setPhotos((prev) => {
      const updated = prev.filter((p) => p.id !== id);
      const photosKey = `neon_photos_${groomName.toLowerCase()}_${brideName.toLowerCase()}`;
      localStorage.setItem(photosKey, JSON.stringify(updated));
      return updated;
    });
  }, [groomName, brideName]);

  const resetToDefault = useCallback(() => {
    setGroomName("Rian");
    setBrideName("Salsa");
    setEventDate("2026-08-08");
    setNeonTheme("pink-cyber");
    setPhotos(DEFAULT_PHOTOS);
    
    localStorage.setItem("neon_groom", "Rian");
    localStorage.setItem("neon_bride", "Salsa");
    localStorage.setItem("neon_date", "2026-08-08");
    localStorage.setItem("neon_theme", "pink-cyber");
    
    const photosKey = "neon_photos_rian_salsa";
    localStorage.setItem(photosKey, JSON.stringify(DEFAULT_PHOTOS));
    document.documentElement.setAttribute("data-theme", "pink-cyber");
  }, []);

  return (
    <AppContext.Provider
      value={{
        groomName,
        brideName,
        eventDate,
        neonTheme,
        photos,
        addPhoto,
        deletePhoto,
        updateEventDetails,
        updateTheme,
        resetToDefault
      }}
    >
      {initialized ? children : <div style={{ minHeight: "100vh", backgroundColor: "#070412" }} />}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return context;
}
