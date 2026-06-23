"use client";

import { useApp } from "@/context/AppContext";
import NeonCard from "@/components/NeonCard";
import Link from "next/link";
import { useEffect, useState, useRef, useCallback } from "react";

export default function SlideshowPage() {
  const { photos, groomName, brideName } = useApp();
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [slideDuration, setSlideDuration] = useState(5000); // 5 seconds default
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Next slide helper
  const nextSlide = useCallback(() => {
    if (photos.length === 0) return;
    setActiveIndex((prevIndex) => (prevIndex + 1) % photos.length);
  }, [photos.length]);

  // Prev slide helper
  const prevSlide = useCallback(() => {
    if (photos.length === 0) return;
    setActiveIndex((prevIndex) => (prevIndex - 1 + photos.length) % photos.length);
  }, [photos.length]);

  // Handle slideshow auto rotation
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    
    if (isPlaying && photos.length > 0) {
      timerRef.current = setInterval(nextSlide, slideDuration);
    }
    
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isPlaying, slideDuration, nextSlide, photos.length]);

  // Toggle fullscreen API
  const toggleFullscreen = () => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().then(() => {
        setIsFullscreen(true);
      }).catch((err) => {
        console.error("Fullscreen error: ", err);
      });
    } else {
      document.exitFullscreen().then(() => {
        setIsFullscreen(false);
      });
    }
  };

  // Sync fullscreen state if user exits via ESC key
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  const activePhoto = photos[activeIndex];

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

  const getFilterColorCode = (filterId: string) => {
    switch (filterId) {
      case "neon-pink":
        return "#ff007f";
      case "neon-cyan":
        return "#00f0ff";
      case "neon-gold":
        return "#ffb800";
      case "neon-green":
        return "#39ff14";
      default:
        return "var(--neon-primary)";
    }
  };

  return (
    <div className="slideshow-outer-container">
      <div ref={containerRef} className="slideshow-main-container">
        {/* Top Floating Branding */}
        <div className="slideshow-header">
          <div className="slideshow-brand">
            <span className="groom">{groomName}</span>
            <span className="ampersand">&</span>
            <span className="bride">{brideName}</span>
          </div>
          <div className="live-badge-glow">
            <span className="badge-pulse-dot" />
            LIVE PHOTO WALL
          </div>
        </div>

        {/* Slide Display Area */}
        {photos.length > 0 ? (
          <div className="slide-wrapper">
            <div className="slide-content-grid">
              {/* Photo Display Card */}
              <div className="slide-photo-panel">
                <NeonCard
                  glowColor={getGlowColorName(activePhoto.filter)}
                  className="slide-neon-card"
                >
                  <div className={`slide-photo-container photo-container-filtered filter-${activePhoto.filter}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={activePhoto.photoUrl}
                      alt={`Karya ${activePhoto.guestName}`}
                      className="slide-img"
                    />
                  </div>
                </NeonCard>
              </div>

              {/* Wishes Details Panel */}
              <div className="slide-wishes-panel">
                <div className="wishes-glass-card glass-panel" style={{ "--border-glow-color": getFilterColorCode(activePhoto.filter) } as React.CSSProperties}>
                  <div className="wishes-quote-icon">“</div>
                  <p className="wishes-body-text">
                    {activePhoto.wishes}
                  </p>
                  <div className="wishes-divider" />
                  <div className="wishes-footer">
                    <h3 className="wishes-guest-name neon-text-primary" style={{ textShadow: `0 0 10px ${getFilterColorCode(activePhoto.filter)}, 0 0 20px ${getFilterColorCode(activePhoto.filter)}` }}>
                      {activePhoto.guestName}
                    </h3>
                    <span className="wishes-timestamp">Dikirim pukul {activePhoto.timestamp}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="slideshow-empty glass-panel neon-border-primary">
            <h2>Belum Ada Foto untuk Ditayangkan</h2>
            <p>Silakan gunakan tombol di bawah atau scan QR untuk mengunggah foto pertama Anda.</p>
            <Link href="/upload" className="btn btn-primary">
              Kirim Foto Sekarang
            </Link>
          </div>
        )}

        {/* Bottom Floating QR and Info Banner */}
        <div className="slideshow-bottom-banner glass-panel">
          <div className="banner-qr-box">
            {/* Minimal neon QR graphic */}
            <div className="mini-qr">
              <div className="q-corner q-tl" />
              <div className="q-corner q-tr" />
              <div className="q-corner q-bl" />
              <div className="q-inner-dot" />
            </div>
          </div>
          <div className="banner-text">
            <h4>Punya foto seru di acara ini? Kirim sekarang!</h4>
            <p>Buka web <strong>nakhawedding.com</strong> atau scan QR diatas</p>
          </div>

          {/* Interactive Controls Overlay (visible on hover) */}
          <div className="slideshow-controls">
            <button className="control-btn" onClick={prevSlide} aria-label="Slide sebelumnya">
              ⏮️
            </button>
            <button className="control-btn play-pause-btn" onClick={() => setIsPlaying(!isPlaying)} aria-label={isPlaying ? "Jeda" : "Putar"}>
              {isPlaying ? "⏸️ Jeda" : "▶️ Putar"}
            </button>
            <button className="control-btn" onClick={nextSlide} aria-label="Slide selanjutnya">
              ⏭️
            </button>
            <div className="divider-line" />
            <select
              className="duration-select"
              value={slideDuration}
              onChange={(e) => setSlideDuration(Number(e.target.value))}
              aria-label="Durasi slide"
            >
              <option value={3000}>3 Detik</option>
              <option value={5000}>5 Detik</option>
              <option value={8000}>8 Detik</option>
              <option value={12000}>12 Detik</option>
            </select>
            <button className="control-btn fullscreen-btn" onClick={toggleFullscreen}>
              {isFullscreen ? "📴 Keluar Layar Penuh" : "📺 Layar Penuh"}
            </button>
          </div>
        </div>
      </div>

      <style jsx>{`
        .slideshow-outer-container {
          padding: 20px;
          flex: 1;
          display: flex;
          flex-direction: column;
          background: #000;
        }

        .slideshow-main-container {
          position: relative;
          background: #000;
          flex: 1;
          border-radius: 20px;
          border: 1px solid rgba(255, 255, 255, 0.05);
          overflow: hidden;
          display: flex;
          flex-direction: column;
          padding: 40px;
          min-height: 75vh;
        }

        /* Top Header */
        .slideshow-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 30px;
          z-index: 10;
        }

        .slideshow-brand {
          font-family: var(--font-serif);
          font-size: 1.8rem;
          font-weight: 700;
          color: #fff;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .slideshow-brand .groom {
          color: #fff;
          text-shadow: var(--neon-primary-glow);
        }

        .slideshow-brand .ampersand {
          color: var(--text-muted);
          font-size: 1.3rem;
          font-style: italic;
        }

        .slideshow-brand .bride {
          color: #fff;
          text-shadow: var(--neon-secondary-glow);
        }

        .live-badge-glow {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 18px;
          border-radius: 30px;
          font-size: 0.8rem;
          font-weight: 800;
          letter-spacing: 1.5px;
          color: #ff007f;
          border: 1px solid #ff007f;
          box-shadow: 0 0 10px rgba(255, 0, 127, 0.2), inset 0 0 5px rgba(255, 0, 127, 0.1);
        }

        .badge-pulse-dot {
          width: 8px;
          height: 8px;
          background-color: #ff007f;
          border-radius: 50%;
          box-shadow: 0 0 8px #ff007f;
          animation: dot-pulse 1.5s infinite;
        }

        @keyframes dot-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.4); opacity: 0.4; }
        }

        /* Slide Content Grid */
        .slide-wrapper {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 10px;
        }

        .slide-content-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 50px;
          width: 100%;
          align-items: center;
        }

        .slide-photo-panel {
          display: flex;
          justify-content: center;
          align-items: center;
        }

        .slide-neon-card {
          width: 100%;
          max-width: 480px;
          aspect-ratio: 4/3;
          border-radius: 20px !important;
          overflow: hidden;
        }

        .slide-photo-container {
          position: relative;
          width: 100%;
          height: 100%;
        }

        .slide-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .slide-wishes-panel {
          display: flex;
          justify-content: flex-start;
        }

        .wishes-glass-card {
          width: 100%;
          max-width: 500px;
          padding: 40px;
          border-radius: 24px;
          position: relative;
          border-color: rgba(255, 255, 255, 0.08);
          box-shadow: var(--glass-shadow);
          background: rgba(14, 10, 31, 0.65);
          /* Subtle border glow mapping to active filter color */
          border-left: 3px solid var(--border-glow-color, var(--neon-primary));
        }

        .wishes-quote-icon {
          position: absolute;
          top: -15px;
          left: 30px;
          font-family: var(--font-serif);
          font-size: 5rem;
          font-weight: 800;
          color: var(--border-glow-color, var(--neon-primary));
          opacity: 0.25;
          line-height: 1;
        }

        .wishes-body-text {
          font-size: 1.5rem;
          font-weight: 400;
          line-height: 1.7;
          color: #fff;
          margin-bottom: 24px;
          font-family: var(--font-sans);
          word-break: break-word;
        }

        .wishes-divider {
          width: 60px;
          height: 2px;
          background: var(--border-glow-color, var(--neon-primary));
          box-shadow: 0 0 6px var(--border-glow-color, var(--neon-primary));
          margin-bottom: 20px;
        }

        .wishes-footer {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .wishes-guest-name {
          font-size: 1.6rem;
          font-weight: 800;
          color: #fff;
        }

        .wishes-timestamp {
          font-size: 0.85rem;
          color: var(--text-muted);
        }

        /* Empty State */
        .slideshow-empty {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 16px;
          padding: 60px;
          text-align: center;
          border-radius: 16px;
          max-width: 500px;
          margin: auto;
        }

        .slideshow-empty h2 {
          font-size: 1.8rem;
          font-weight: 700;
        }

        .slideshow-empty p {
          color: var(--text-muted);
          max-width: 320px;
          margin-bottom: 12px;
        }

        /* Bottom Floating Banner */
        .slideshow-bottom-banner {
          display: flex;
          align-items: center;
          gap: 20px;
          padding: 16px 28px;
          border-radius: 16px;
          margin-top: 30px;
          position: relative;
          z-index: 12;
          overflow: visible; /* allows overlay menu to be seen */
        }

        .banner-qr-box {
          background: #fff;
          padding: 8px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 0 10px rgba(255, 255, 255, 0.1);
        }

        .mini-qr {
          width: 36px;
          height: 36px;
          position: relative;
          border: 1px solid #000;
        }

        .q-corner {
          position: absolute;
          width: 8px;
          height: 8px;
          border: 1.5px solid #000;
        }
        .q-tl { top: 0; left: 0; border-right: none; border-bottom: none; }
        .q-tr { top: 0; right: 0; border-left: none; border-bottom: none; }
        .q-bl { bottom: 0; left: 0; border-right: none; border-top: none; }
        .q-inner-dot {
          position: absolute;
          top: 13px;
          left: 13px;
          width: 10px;
          height: 10px;
          background: #000;
        }

        .banner-text h4 {
          font-size: 0.95rem;
          font-weight: 700;
          color: #fff;
        }

        .banner-text p {
          font-size: 0.8rem;
          color: var(--text-muted);
        }

        /* Controls Hover Overlay */
        .slideshow-controls {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(7, 4, 18, 0.92);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border-radius: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 16px;
          opacity: 0;
          pointer-events: none;
          transition: all 0.3s ease;
        }

        .slideshow-bottom-banner:hover .slideshow-controls {
          opacity: 1;
          pointer-events: auto;
        }

        .control-btn {
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #fff;
          padding: 8px 16px;
          border-radius: 30px;
          cursor: pointer;
          font-weight: 600;
          font-size: 0.85rem;
          transition: all 0.2s ease;
        }

        .control-btn:hover {
          background: #fff;
          color: #000;
        }

        .play-pause-btn {
          border-color: var(--neon-secondary);
          box-shadow: var(--neon-secondary-glow);
        }

        .play-pause-btn:hover {
          background: var(--neon-secondary);
          color: #000;
          box-shadow: 0 0 10px var(--neon-secondary);
        }

        .divider-line {
          width: 1px;
          height: 24px;
          background: rgba(255, 255, 255, 0.2);
        }

        .duration-select {
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #fff;
          padding: 8px 12px;
          border-radius: 20px;
          outline: none;
          font-size: 0.85rem;
          cursor: pointer;
        }

        /* Fullscreen styles overrides */
        :fullscreen .slideshow-main-container {
          width: 100vw;
          height: 100vh;
          border-radius: 0;
          padding: 60px;
        }

        :fullscreen .wishes-glass-card {
          max-width: 600px;
          padding: 50px;
        }

        :fullscreen .wishes-body-text {
          font-size: 2rem;
        }

        :fullscreen .wishes-guest-name {
          font-size: 2.2rem;
        }

        /* Mobile adaptation */
        @media (max-width: 992px) {
          .slide-content-grid {
            grid-template-columns: 1fr;
            gap: 30px;
          }
          
          .slide-neon-card {
            max-width: 380px;
          }
          
          .wishes-glass-card {
            max-width: 380px;
            padding: 24px;
          }

          .wishes-body-text {
            font-size: 1.15rem;
          }
        }

        @media (max-width: 768px) {
          .slideshow-main-container {
            padding: 20px;
          }
          
          .slideshow-brand {
            font-size: 1.4rem;
          }

          .wishes-body-text {
            font-size: 1rem;
            margin-bottom: 12px;
          }

          .wishes-guest-name {
            font-size: 1.25rem;
          }

          .banner-text {
            display: none;
          }
          
          .slideshow-controls {
            flex-wrap: wrap;
            gap: 8px;
            padding: 10px;
          }
        }
      `}</style>
    </div>
  );
}
