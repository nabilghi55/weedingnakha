"use client";

import { useApp, WeddingPhoto } from "@/context/AppContext";
import NeonCard from "@/components/NeonCard";
import Link from "next/link";
import { useState, useMemo } from "react";

export default function GalleryPage() {
  const { photos, groomName, brideName } = useApp();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilterTab, setActiveFilterTab] = useState<string>("all");

  const filterTabs = [
    { id: "all", name: "Semua", color: "var(--neon-primary)" },
    { id: "neon-pink", name: "Cyber Pink", color: "#ff007f" },
    { id: "neon-cyan", name: "Future Cyan", color: "#00f0ff" },
    { id: "neon-gold", name: "Golden Hour", color: "#ffb800" },
    { id: "neon-green", name: "Acid Green", color: "#39ff14" },
  ];

  const filteredPhotos = useMemo(() => {
    return photos.filter((photo) => {
      const matchesSearch =
        photo.guestName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        photo.wishes.toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesFilter =
        activeFilterTab === "all" || photo.filter === activeFilterTab;

      return matchesSearch && matchesFilter;
    });
  }, [photos, searchQuery, activeFilterTab]);

  const getGlowColorName = (filterId: string): "primary" | "secondary" | "pink" | "cyan" | "gold" | "green" => {
    switch (filterId) {
      case "neon-pink":
        return "pink";
      case "neon-cyan":
        return "cyan";
      case "neon-gold":
        return "gold";
      case "neon-green":
        return "green";
      default:
        return "primary";
    }
  };

  return (
    <div className="gallery-page-container container">
      {/* Page Header */}
      <header className="gallery-header">
        <h1 className="gallery-title">
          Galeri Foto <span className="neon-text-primary">Live</span>
        </h1>
        <p className="gallery-subtitle">
          Kumpulan momen candid dan ucapan hangat dari para tamu untuk pernikahan{" "}
          <span className="couple-names">{groomName} & {brideName}</span>
        </p>
      </header>

      {/* Control Panel (Search & Filter) */}
      <div className="control-panel glass-panel">
        <div className="search-box-wrapper">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            className="input-field search-input"
            placeholder="Cari nama tamu atau ucapan..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="clear-btn" onClick={() => setSearchQuery("")}>
              ✕
            </button>
          )}
        </div>

        <div className="filter-tabs-container">
          <span className="filter-label">Filter:</span>
          <div className="filter-tabs">
            {filterTabs.map((tab) => (
              <button
                key={tab.id}
                className={`filter-tab-btn ${activeFilterTab === tab.id ? "active" : ""}`}
                onClick={() => setActiveFilterTab(tab.id)}
                style={{ "--tab-accent": tab.color } as React.CSSProperties}
              >
                {tab.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Gallery Grid */}
      {filteredPhotos.length > 0 ? (
        <div className="grid-gallery">
          {filteredPhotos.map((photo) => (
            <NeonCard
              key={photo.id}
              glowColor={getGlowColorName(photo.filter)}
              className="gallery-card"
            >
              {/* Photo Box with Filter */}
              <div className={`gallery-photo-box photo-container-filtered filter-${photo.filter}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.photoUrl} alt={`Foto dari ${photo.guestName}`} className="gallery-img" />
                <div className="photo-time-badge">{photo.timestamp}</div>
              </div>

              {/* Guest Message Details */}
              <div className="gallery-card-details">
                <div className="guest-info">
                  <h3 className="guest-name">{photo.guestName}</h3>
                  <div className="guest-dot" style={{ backgroundColor: filterTabs.find(t => t.id === photo.filter)?.color || "var(--neon-primary)" }} />
                </div>
                <p className="guest-wishes">"{photo.wishes}"</p>
              </div>
            </NeonCard>
          ))}
        </div>
      ) : (
        <div className="empty-state glass-panel neon-border-secondary">
          <div className="empty-icon">📸</div>
          <h3>Tidak ada foto ditemukan</h3>
          <p>Coba ubah kata kunci pencarian atau filter warna Anda.</p>
          <Link href="/upload" className="btn btn-primary empty-action">
            Kirim Foto Pertama
          </Link>
        </div>
      )}

      {/* Floating CTA for Mobile Upload */}
      <div className="floating-cta-container">
        <Link href="/upload" className="btn btn-primary floating-cta-btn">
          📸 Kirim Foto Anda
        </Link>
      </div>

      <style jsx>{`
        .gallery-page-container {
          padding: 140px 20px 100px !important;
          display: flex;
          flex-direction: column;
          gap: 40px;
          position: relative;
        }

        .gallery-header {
          text-align: center;
          margin-top: 60px;
        }

        .gallery-title {
          font-family: var(--font-serif);
          font-size: 2.8rem;
          font-weight: 700;
          margin-bottom: 10px;
        }

        .gallery-subtitle {
          font-size: 1.1rem;
          color: var(--text-muted);
          max-width: 600px;
          margin: 0 auto;
        }

        .couple-names {
          color: #fff;
          font-weight: 600;
          text-shadow: 0 0 8px rgba(255, 255, 255, 0.2);
        }

        /* Control Panel */
        .control-panel {
          padding: 24px;
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .search-box-wrapper {
          position: relative;
          display: flex;
          align-items: center;
          width: 100%;
        }

        .search-icon {
          position: absolute;
          left: 16px;
          font-size: 1.1rem;
          color: var(--text-muted);
        }

        .search-input {
          padding-left: 48px !important;
          padding-right: 40px !important;
        }

        .clear-btn {
          position: absolute;
          right: 16px;
          background: transparent;
          border: none;
          color: var(--text-muted);
          font-size: 1rem;
          cursor: pointer;
          transition: color 0.2s ease;
        }

        .clear-btn:hover {
          color: #fff;
        }

        .filter-tabs-container {
          display: flex;
          align-items: center;
          gap: 16px;
          flex-wrap: wrap;
        }

        .filter-label {
          font-weight: 600;
          font-size: 0.95rem;
          color: var(--text-muted);
        }

        .filter-tabs {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }

        .filter-tab-btn {
          padding: 6px 16px;
          border-radius: 20px;
          font-size: 0.85rem;
          font-weight: 600;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: var(--text-muted);
          cursor: pointer;
          transition: all 0.3s ease;
        }

        .filter-tab-btn:hover {
          color: #fff;
          background: rgba(255, 255, 255, 0.08);
        }

        .filter-tab-btn.active {
          color: #fff;
          background: rgba(255, 255, 255, 0.05);
          border-color: var(--tab-accent, var(--neon-primary));
          box-shadow: 0 0 10px rgba(255, 255, 255, 0.02), 0 0 8px var(--tab-accent, var(--neon-primary));
          text-shadow: 0 0 5px rgba(255, 255, 255, 0.3);
        }

        /* Gallery Card Styles */
        .gallery-card {
          display: flex;
          flex-direction: column;
          height: 100%;
          overflow: hidden;
          border-radius: 16px;
        }

        .gallery-photo-box {
          position: relative;
          width: 100%;
          aspect-ratio: 4/3;
          background: #000;
        }

        .gallery-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .photo-time-badge {
          position: absolute;
          bottom: 12px;
          right: 12px;
          background: rgba(0, 0, 0, 0.65);
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 0.75rem;
          font-weight: 600;
          color: #fff;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .gallery-card-details {
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          flex: 1;
        }

        .guest-info {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .guest-name {
          font-size: 1.1rem;
          font-weight: 700;
          color: #fff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .guest-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          box-shadow: 0 0 6px currentColor;
          flex-shrink: 0;
        }

        .guest-wishes {
          font-size: 0.92rem;
          color: var(--text-muted);
          line-height: 1.6;
          font-style: italic;
        }

        /* Empty State */
        .empty-state {
          padding: 60px 40px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          gap: 16px;
          border-radius: 20px;
          max-width: 500px;
          margin: 40px auto 0;
        }

        .empty-icon {
          font-size: 3rem;
          animation: float 4s ease-in-out infinite;
        }

        .empty-state h3 {
          font-size: 1.4rem;
          font-weight: 700;
        }

        .empty-state p {
          font-size: 0.95rem;
          color: var(--text-muted);
          max-width: 320px;
        }

        .empty-action {
          margin-top: 8px;
        }

        /* Floating CTA */
        .floating-cta-container {
          position: fixed;
          bottom: 30px;
          left: 0;
          right: 0;
          display: flex;
          justify-content: center;
          z-index: 99;
          pointer-events: none;
        }

        .floating-cta-btn {
          pointer-events: auto;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), var(--neon-primary-glow) !important;
          transform: translateY(0);
        }

        .floating-cta-btn:hover {
          transform: translateY(-4px) scale(1.02);
        }

        @media (max-width: 768px) {
          .gallery-page-container {
            padding: 100px 16px 60px !important;
          }
          .gallery-header {
            margin-top: 20px !important;
          }
          .gallery-title {
            font-size: 2.2rem;
          }
          .control-panel {
            padding: 16px;
            gap: 16px;
          }
          .filter-tabs-container {
            gap: 8px;
          }
        }
      `}</style>
    </div>
  );
}
