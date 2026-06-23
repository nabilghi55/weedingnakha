"use client";

import Link from "next/link";
import Image from "next/image";
import { useApp } from "@/context/AppContext";
import NeonCard from "@/components/NeonCard";
import { useEffect, useState, useRef } from "react";

export default function Home() {
  const { groomName, brideName, eventDate } = useApp();
  const [timeLeft, setTimeLeft] = useState({
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 0,
    isOver: false
  });

  // Gateway Simulation State
  const [hasScanned, setHasScanned] = useState<boolean | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanMethod, setScanMethod] = useState<'instant' | 'camera' | null>(null);
  const [scanProgress, setScanProgress] = useState(0);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // QR graphic pixels helper
  const activeQrPixels = [
    [0,0], [0,1], [0,2], [0,7], [0,8], [0,9],
    [1,0], [1,2], [1,7], [1,9],
    [2,0], [2,1], [2,2], [2,7], [2,8], [2,9],
    [3,3], [3,5], [3,6],
    [4,1], [4,4], [4,8],
    [5,0], [5,3], [5,6], [5,9],
    [6,2], [6,5], [6,8],
    [7,0], [7,1], [7,2], [7,7], [7,8], [7,9],
    [8,0], [8,2], [8,7], [8,9],
    [9,0], [9,1], [9,2], [9,7], [9,8], [9,9]
  ];

  // Check sessionStorage on mount to avoid repeating scan in same browser session
  useEffect(() => {
    if (typeof window !== "undefined") {
      const scanned = sessionStorage.getItem("nakhawedding_scanned") === "true";
      setHasScanned(scanned);
    }
  }, []);

  // Cleanup camera stream on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // Countdown logic
  useEffect(() => {
    const calculateTime = () => {
      const now = new Date().getTime();
      const target = new Date(eventDate).getTime();
      const difference = target - now;

      if (difference <= 0) {
        setTimeLeft(prev => ({ ...prev, isOver: true }));
        return;
      }

      const days = Math.floor(difference / (1000 * 60 * 60 * 24));
      const hours = Math.floor((difference % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((difference % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((difference % (1000 * 60)) / 1000);

      setTimeLeft({ days, hours, minutes, seconds, isOver: false });
    };

    calculateTime();
    const interval = setInterval(calculateTime, 1000);
    return () => clearInterval(interval);
  }, [eventDate]);

  // Audio scan success beep synthesizer
  const playBeep = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(950, ctx.currentTime);
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch (e) {
      console.warn("Audio Context blocked or not supported:", e);
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const handleScanSuccess = () => {
    playBeep();
    stopCamera();
    setTimeout(() => {
      sessionStorage.setItem("nakhawedding_scanned", "true");
      setHasScanned(true);
    }, 600);
  };

  const startCamera = async () => {
    try {
      setCameraError(null);
      setScanMethod('camera');
      setIsScanning(true);
      setScanProgress(0);
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }
      });
      
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      let progress = 0;
      const progressInterval = setInterval(() => {
        progress += 4;
        setScanProgress(Math.min(progress, 100));
        if (progress >= 100) {
          clearInterval(progressInterval);
          handleScanSuccess();
        }
      }, 100);

    } catch (err: any) {
      console.error("Camera access error:", err);
      setCameraError("Kamera tidak dapat diakses atau diblokir. Menggunakan Scan Instan...");
      setIsScanning(false);
      
      // Auto fallback to instant scan simulation after brief delay
      setTimeout(() => {
        handleInstantScan();
      }, 1500);
    }
  };

  const handleInstantScan = () => {
    setIsScanning(true);
    setScanMethod('instant');
    setScanProgress(0);
    
    let progress = 0;
    const progressInterval = setInterval(() => {
      progress += 10;
      setScanProgress(Math.min(progress, 100));
      if (progress >= 100) {
        clearInterval(progressInterval);
        handleScanSuccess();
      }
    }, 80);
  };

  if (hasScanned === null) {
    return <div style={{ minHeight: "100vh", backgroundColor: "#070412" }} />;
  }

  return (
    <>
      {!hasScanned ? (
        <div className="gateway-container">
          <div className="neon-orb-1" />
          <div className="neon-orb-2" />
          
          <div className="gateway-glass-panel">
            <div className="gateway-header">
              <span className="gateway-subtitle">LIVE EVENT GALLERY & BOOK</span>
              <h1 className="gateway-brand">
                <span className="neon-text-primary logo-groom">Nakha</span>
                <span className="neon-text-secondary logo-bride" style={{ marginLeft: "6px" }}>Wedding</span>
              </h1>
            </div>

            <div className="gateway-instruction">
              Selamat datang di pesta pernikahan <strong>{groomName} & {brideName}</strong>.<br />
              Silakan pindai kode QR undangan fisik Anda atau simulasikan pemindaian untuk masuk.
            </div>

            <div className="scan-window-wrapper">
              <div className={`scan-frame ${isScanning ? "scanning-active" : ""} ${scanProgress >= 100 ? "success-active" : ""}`}>
                <div className="scan-corner c-tl" />
                <div className="scan-corner c-tr" />
                <div className="scan-corner c-bl" />
                <div className="scan-corner c-br" />
                
                {isScanning && <div className="scan-laser" />}
                
                {scanMethod === 'camera' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <video ref={videoRef} autoPlay playsInline className="scan-video" />
                ) : (
                  <div className="gateway-qr-graphic">
                    <div className="gateway-qr-corner g-qr-tl" />
                    <div className="gateway-qr-corner g-qr-tr" />
                    <div className="gateway-qr-corner g-qr-bl" />
                    <div className="gateway-qr-grid">
                      {Array.from({ length: 10 }).map((_, r) => 
                        Array.from({ length: 10 }).map((_, c) => {
                          const isActive = activeQrPixels.some(([pr, pc]) => pr === r && pc === c);
                          return (
                            <div 
                              key={`${r}-${c}`} 
                              className={`qr-pixel ${isActive ? "active-pixel" : ""}`} 
                            />
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="gateway-actions">
              {scanProgress >= 100 ? (
                <div className="success-text">🎉 KODE QR BERHASIL DIPINDAI!</div>
              ) : isScanning ? (
                <div>
                  <div style={{ fontSize: "0.85rem", color: "var(--neon-secondary)", fontWeight: 600 }}>
                    {scanMethod === 'camera' ? "Mencari QR Code..." : "Menghubungkan ke Server..."}
                  </div>
                  <div className="progress-container">
                    <div className="progress-bar" style={{ width: `${scanProgress}%` }} />
                  </div>
                </div>
              ) : (
                <>
                  <button className="btn btn-primary gateway-btn" onClick={startCamera}>
                    📸 Pindai Pakai Kamera
                  </button>
                  <button className="btn btn-secondary gateway-btn" onClick={handleInstantScan}>
                    ⚡ Simulasikan Scan Instan
                  </button>
                </>
              )}

              {cameraError && (
                <div style={{ color: "#ff007f", fontSize: "0.8rem", marginTop: "10px", lineHeight: "1.4" }}>
                  {cameraError}
                </div>
              )}

              {isScanning && scanProgress < 100 && (
                <button 
                  className="btn" 
                  style={{ background: "rgba(255, 255, 255, 0.05)", border: "none", color: "#fff", marginTop: "10px" }}
                  onClick={() => {
                    stopCamera();
                    setIsScanning(false);
                    setScanMethod(null);
                  }}
                >
                  Batal
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="home-container">
      {/* Background Neon Orbs */}
      <div className="neon-orb-1" />
      <div className="neon-orb-2" />

      {/* Hero Section */}
      <section className="hero-section">
        <div className="hero-content">
          <div className="wedding-badge glass-panel neon-border-secondary">
            THE WEDDING OF
          </div>
          
          <h1 className="wedding-title">
            <span className="neon-text-primary neon-flicker">{groomName}</span>
            <span className="title-ampersand">&</span>
            <span className="neon-text-secondary">{brideName}</span>
          </h1>

          <p className="wedding-date-text">
            {new Date(eventDate).toLocaleDateString("id-ID", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </p>

          {/* Countdown Timer */}
          {!timeLeft.isOver ? (
            <div className="countdown-grid">
              <div className="countdown-item glass-panel">
                <span className="countdown-number neon-text-primary">{timeLeft.days}</span>
                <span className="countdown-label">Hari</span>
              </div>
              <div className="countdown-item glass-panel">
                <span className="countdown-number neon-text-secondary">{timeLeft.hours}</span>
                <span className="countdown-label">Jam</span>
              </div>
              <div className="countdown-item glass-panel">
                <span className="countdown-number neon-text-primary">{timeLeft.minutes}</span>
                <span className="countdown-label">Menit</span>
              </div>
              <div className="countdown-item glass-panel">
                <span className="countdown-number neon-text-secondary">{timeLeft.seconds}</span>
                <span className="countdown-label">Detik</span>
              </div>
            </div>
          ) : (
            <div className="wedding-started glass-panel neon-border-primary">
              <span className="neon-text-primary text-glow">ACARA SEDANG BERLANGSUNG 💖</span>
            </div>
          )}

          <div className="hero-actions">
            <Link href="/upload" className="btn btn-primary hero-btn">
              📸 Kirim Foto & Ucapan
            </Link>
            <Link href="/gallery" className="btn btn-secondary hero-btn">
              🖼️ Galeri Foto Live
            </Link>
          </div>
        </div>

        {/* Hero Image / Banner */}
        <div className="hero-visual">
          <NeonCard glowColor="primary" className="hero-image-card">
            <div className="hero-image-container">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/couple.png"
                alt="Wedding Couple"
                className="hero-image"
              />
              <div className="hero-image-gradient" />
            </div>
          </NeonCard>
        </div>
      </section>

      {/* How it Works / QR Section */}
      <section className="features-section">
        <h2 className="section-title">
          <span className="neon-text-secondary">Bagikan Momen</span> Indah Anda
        </h2>
        <p className="section-subtitle">
          Mudah, cepat, dan interaktif. Semua tamu dapat berpartisipasi meramaikan galeri foto pernikahan.
        </p>

        <div className="features-grid">
          {/* Card 1: QR Scan */}
          <NeonCard glowColor="pink" className="feature-card">
            <div className="feature-card-content">
              <div className="feature-icon pink">01</div>
              <h3>Pindai Kode QR</h3>
              <p>Scan QR code yang dipajang di meja undangan atau kartu undangan Anda untuk membuka aplikasi langsung dari ponsel.</p>
              
              {/* Interactive Mock QR */}
              <div className="mock-qr-container glass-panel">
                <div className="mock-qr-graphic">
                  {/* Neon Style QR Graphic */}
                  <div className="qr-corner qr-tl" />
                  <div className="qr-corner qr-tr" />
                  <div className="qr-corner qr-bl" />
                  <div className="qr-dot dot-1" />
                  <div className="qr-dot dot-2" />
                  <div className="qr-dot dot-3" />
                  <div className="qr-dot dot-4" />
                </div>
                <Link href="/upload" className="qr-simulate-btn">
                  Simulasikan Scan QR ↗
                </Link>
              </div>
            </div>
          </NeonCard>

          {/* Card 2: Upload Photo */}
          <NeonCard glowColor="cyan" className="feature-card">
            <div className="feature-card-content">
              <div className="feature-icon cyan">02</div>
              <h3>Unggah Foto Candid</h3>
              <p>Ambil foto Anda secara langsung menggunakan kamera ponsel, atau pilih dari galeri. Tambahkan ucapan doa restu.</p>
              <div className="feature-graphic-preview">
                <div className="mock-photo-card glass-panel">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/images/rings.png" alt="Rings Demo" className="mock-photo-img" />
                  <div className="mock-photo-caption">
                    <span className="mock-photo-name">Budi S.</span>
                    <span className="mock-photo-text">Langgeng terus! 🎉</span>
                  </div>
                </div>
              </div>
            </div>
          </NeonCard>

          {/* Card 3: Live Slideshow */}
          <NeonCard glowColor="gold" className="feature-card">
            <div className="feature-card-content">
              <div className="feature-icon gold">03</div>
              <h3>Tampil di Proyektor</h3>
              <p>Foto dan ucapan Anda akan secara instan ditayangkan di layar proyektor panggung pernikahan dalam transisi neon yang mewah.</p>
              <div className="feature-graphic-preview">
                <div className="mock-projector glass-panel">
                  <div className="projector-beam" />
                  <div className="projector-screen">
                    <div className="screen-neon-title">LIVE PHOTO WALL</div>
                    <div className="screen-gallery-dots">
                      <span className="dot active" />
                      <span className="dot" />
                      <span className="dot" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </NeonCard>
        </div>
      </section>
    </div>
  )}

      <style jsx>{`
        .home-container {
          position: relative;
          padding: 40px 20px 80px;
          display: flex;
          flex-direction: column;
          gap: 100px;
          overflow: hidden;
          width: 100%;
          max-width: 1200px;
          margin: 0 auto;
        }

        /* Ambient glows */
        .neon-orb-1 {
          position: absolute;
          width: 350px;
          height: 350px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(255, 0, 127, 0.15) 0%, rgba(0, 0, 0, 0) 70%);
          top: 10%;
          left: -100px;
          z-index: -1;
          filter: blur(40px);
        }

        .neon-orb-2 {
          position: absolute;
          width: 400px;
          height: 400px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(0, 240, 255, 0.15) 0%, rgba(0, 0, 0, 0) 70%);
          top: 40%;
          right: -150px;
          z-index: -1;
          filter: blur(40px);
        }

        /* Hero */
        .hero-section {
          display: grid;
          grid-template-columns: 1.2fr 1fr;
          gap: 60px;
          align-items: center;
          min-height: 70vh;
        }

        .hero-content {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 24px;
        }

        .wedding-badge {
          padding: 8px 20px;
          font-weight: 700;
          font-size: 0.85rem;
          letter-spacing: 3px;
          color: var(--neon-secondary);
          border-radius: 20px;
        }

        .wedding-title {
          font-family: var(--font-serif);
          font-size: 4.2rem;
          font-weight: 700;
          line-height: 1.2;
          letter-spacing: -1px;
        }

        .title-ampersand {
          font-family: var(--font-serif);
          font-size: 3.5rem;
          font-style: italic;
          font-weight: 300;
          color: var(--text-muted);
          margin: 0 12px;
          text-shadow: none;
        }

        .wedding-date-text {
          font-size: 1.1rem;
          color: #fff;
          font-weight: 600;
          letter-spacing: 2px;
          text-transform: uppercase;
          text-shadow: 0 0 8px rgba(255, 255, 255, 0.15);
        }

        .countdown-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 16px;
          width: 100%;
          max-width: 420px;
          margin-top: 10px;
        }

        .countdown-item {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 16px 8px;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.05);
          transition: all 0.3s ease;
        }

        .countdown-item:hover {
          border-color: var(--neon-secondary);
          box-shadow: 0 0 15px rgba(0, 240, 255, 0.1);
          transform: translateY(-2px);
        }

        .countdown-number {
          font-size: 2.5rem;
          font-weight: 800;
          line-height: 1;
        }

        .countdown-label {
          font-size: 0.75rem;
          color: var(--text-muted);
          text-transform: uppercase;
          margin-top: 4px;
          font-weight: 600;
        }

        .wedding-started {
          padding: 16px 24px;
          border-radius: 12px;
          font-weight: 700;
          font-size: 1.1rem;
          text-align: center;
        }

        .hero-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 16px;
          margin-top: 12px;
        }

        .hero-visual {
          width: 100%;
          display: flex;
          justify-content: center;
        }

        .hero-image-card {
          width: 100%;
          max-width: 380px;
          height: 460px;
          border-radius: 24px !important;
          overflow: hidden;
          transform: rotate(2deg);
          transition: all 0.5s cubic-bezier(0.25, 0.8, 0.25, 1) !important;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4), var(--neon-primary-glow) !important;
        }

        .hero-image-card:hover {
          transform: rotate(0deg) scale(1.03) !important;
          box-shadow: 0 15px 40px rgba(0, 0, 0, 0.5), 0 0 20px var(--neon-primary) !important;
        }

        .hero-image-container {
          position: relative;
          width: 100%;
          height: 100%;
          background: #000;
        }

        .hero-image {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }

        .hero-image-gradient {
          position: absolute;
          bottom: 0;
          left: 0;
          width: 100%;
          height: 35%;
          background: linear-gradient(to top, rgba(7, 4, 18, 0.9), transparent);
          pointer-events: none;
        }

        /* Features / QR Section */
        .features-section {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 20px;
          text-align: center;
        }

        .section-title {
          font-family: var(--font-serif);
          font-size: 2.5rem;
          font-weight: 700;
        }

        .section-subtitle {
          font-size: 1.1rem;
          color: var(--text-muted);
          max-width: 600px;
          margin-bottom: 20px;
        }

        .features-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 30px;
          width: 100%;
          margin-top: 20px;
        }

        .feature-card {
          height: 100%;
        }

        .feature-card-content {
          padding: 30px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
          height: 100%;
          text-align: center;
        }

        .feature-icon {
          width: 60px;
          height: 60px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1.25rem;
          font-weight: 800;
          margin-bottom: 8px;
        }

        .feature-icon.pink {
          background: rgba(255, 0, 127, 0.1);
          color: #ff007f;
          border: 1px solid #ff007f;
          box-shadow: 0 0 10px rgba(255, 0, 127, 0.2);
        }

        .feature-icon.cyan {
          background: rgba(0, 240, 255, 0.1);
          color: #00f0ff;
          border: 1px solid #00f0ff;
          box-shadow: 0 0 10px rgba(0, 240, 255, 0.2);
        }

        .feature-icon.gold {
          background: rgba(255, 184, 0, 0.1);
          color: #ffb800;
          border: 1px solid #ffb800;
          box-shadow: 0 0 10px rgba(255, 184, 0, 0.2);
        }

        .feature-card-content h3 {
          font-size: 1.3rem;
          font-weight: 700;
        }

        .feature-card-content p {
          font-size: 0.95rem;
          color: var(--text-muted);
          line-height: 1.6;
        }

        /* Mock QR Graphic */
        .mock-qr-container {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          padding: 16px;
          border-radius: 12px;
          width: 100%;
          max-width: 180px;
          margin-top: auto;
          background: rgba(0, 0, 0, 0.3) !important;
        }

        .mock-qr-graphic {
          width: 100px;
          height: 100px;
          border: 1px solid rgba(255, 0, 127, 0.2);
          position: relative;
          background: radial-gradient(circle, rgba(255, 0, 127, 0.05) 0%, transparent 100%);
        }

        .qr-corner {
          position: absolute;
          width: 16px;
          height: 16px;
          border: 2px solid #ff007f;
          box-shadow: 0 0 8px #ff007f;
        }

        .qr-tl { top: 0; left: 0; border-right: none; border-bottom: none; }
        .qr-tr { top: 0; right: 0; border-left: none; border-bottom: none; }
        .qr-bl { bottom: 0; left: 0; border-right: none; border-top: none; }

        .qr-dot {
          position: absolute;
          background: #ff007f;
          box-shadow: 0 0 6px #ff007f;
          border-radius: 2px;
        }

        .dot-1 { top: 30px; left: 30px; width: 14px; height: 14px; }
        .dot-2 { top: 30px; right: 25px; width: 10px; height: 10px; }
        .dot-3 { bottom: 25px; left: 30px; width: 12px; height: 12px; }
        .dot-4 { bottom: 35px; right: 35px; width: 16px; height: 8px; }

        .qr-simulate-btn {
          font-size: 0.8rem;
          color: #ff007f;
          text-shadow: var(--neon-primary-glow);
          font-weight: 600;
          transition: all 0.3s ease;
        }

        .qr-simulate-btn:hover {
          color: #fff;
        }

        /* Mock Graphic Previews */
        .feature-graphic-preview {
          width: 100%;
          display: flex;
          justify-content: center;
          margin-top: auto;
        }

        .mock-photo-card {
          width: 100%;
          max-width: 180px;
          border-radius: 10px;
          overflow: hidden;
          background: rgba(0, 0, 0, 0.4) !important;
          border: 1px solid rgba(0, 240, 255, 0.2);
          box-shadow: 0 0 10px rgba(0, 240, 255, 0.1);
        }

        .mock-photo-img {
          width: 100%;
          height: 110px;
          object-fit: cover;
        }

        .mock-photo-caption {
          padding: 8px;
          text-align: left;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .mock-photo-name {
          font-size: 0.75rem;
          font-weight: 700;
          color: #00f0ff;
        }

        .mock-photo-text {
          font-size: 0.7rem;
          color: var(--text-light);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .mock-projector {
          width: 100%;
          max-width: 180px;
          height: 140px;
          background: rgba(0, 0, 0, 0.5) !important;
          border-radius: 10px;
          position: relative;
          overflow: hidden;
          border: 1px solid rgba(255, 184, 0, 0.2);
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
        }

        .projector-beam {
          position: absolute;
          top: -20px;
          width: 200px;
          height: 180px;
          background: conic-gradient(from 150deg at 50% 0%, rgba(255, 184, 0, 0.08) 0deg, transparent 60deg, transparent 300deg, rgba(255, 184, 0, 0.08) 360deg);
          pointer-events: none;
        }

        .projector-screen {
          width: 140px;
          height: 80px;
          border: 1.5px solid #ffb800;
          box-shadow: 0 0 10px rgba(255, 184, 0, 0.2), inset 0 0 10px rgba(255, 184, 0, 0.1);
          background: #0d081c;
          z-index: 1;
          border-radius: 4px;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          gap: 8px;
        }

        .screen-neon-title {
          font-size: 0.6rem;
          font-weight: 800;
          color: #ffb800;
          text-shadow: 0 0 4px #ffb800;
          letter-spacing: 1px;
        }

        .screen-gallery-dots {
          display: flex;
          gap: 6px;
        }

        .screen-gallery-dots .dot {
          width: 4px;
          height: 4px;
          border-radius: 50%;
          background: rgba(255, 184, 0, 0.3);
        }

        .screen-gallery-dots .dot.active {
          background: #ffb800;
          box-shadow: 0 0 4px #ffb800;
          transform: scale(1.3);
        }

        /* Responsive Layouts */
        @media (max-width: 992px) {
          .hero-section {
            grid-template-columns: 1fr;
            gap: 40px;
            text-align: center;
          }

          .hero-content {
            align-items: center;
          }

          .title-ampersand {
            align-self: center;
          }

          .features-grid {
            grid-template-columns: 1fr;
            gap: 24px;
            max-width: 500px;
          }
        }

        @media (max-width: 768px) {
          .wedding-title {
            font-size: 3rem;
          }
          .title-ampersand {
            font-size: 2.2rem;
          }
          .section-title {
            font-size: 2rem;
          }
          .home-container {
            gap: 60px;
          }
        }

        /* Gateway Overlay */
        .gateway-container {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background: #070412;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 9999;
          overflow-y: auto;
          padding: 20px;
        }

        .gateway-glass-panel {
          width: 100%;
          max-width: 440px;
          padding: 35px 25px;
          border-radius: 24px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(14, 10, 31, 0.85);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), 0 0 30px rgba(255, 0, 127, 0.15);
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          gap: 20px;
          position: relative;
        }

        .gateway-brand {
          font-family: var(--font-serif);
          font-size: 2rem;
          font-weight: 700;
          letter-spacing: -0.5px;
          margin-top: 4px;
        }

        .gateway-subtitle {
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 3px;
          color: var(--neon-secondary);
          text-shadow: var(--neon-secondary-glow);
          font-weight: 700;
        }

        .gateway-instruction {
          font-size: 0.9rem;
          color: var(--text-muted);
          line-height: 1.6;
        }

        /* Scan Window */
        .scan-window-wrapper {
          width: 200px;
          height: 200px;
          position: relative;
          margin: 5px 0;
        }

        .scan-frame {
          width: 100%;
          height: 100%;
          border: 1.5px dashed rgba(255, 0, 127, 0.25);
          position: relative;
          background: rgba(0, 0, 0, 0.45);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          border-radius: 16px;
          transition: all 0.3s ease;
        }

        .scan-frame.scanning-active {
          border-color: var(--neon-secondary);
          box-shadow: 0 0 20px rgba(0, 240, 255, 0.25);
        }

        .scan-frame.success-active {
          border-color: #39ff14;
          box-shadow: 0 0 25px rgba(57, 255, 20, 0.4);
        }

        /* Corners */
        .scan-corner {
          position: absolute;
          width: 18px;
          height: 18px;
          border: 3px solid var(--neon-primary);
          box-shadow: 0 0 8px var(--neon-primary);
          transition: all 0.3s ease;
        }

        .scan-frame.scanning-active .scan-corner {
          border-color: var(--neon-secondary);
          box-shadow: 0 0 8px var(--neon-secondary);
        }

        .scan-frame.success-active .scan-corner {
          border-color: #39ff14;
          box-shadow: 0 0 12px #39ff14;
        }

        .c-tl { top: 0; left: 0; border-right: none; border-bottom: none; border-top-left-radius: 14px; }
        .c-tr { top: 0; right: 0; border-left: none; border-bottom: none; border-top-right-radius: 14px; }
        .c-bl { bottom: 0; left: 0; border-right: none; border-top: none; border-bottom-left-radius: 14px; }
        .c-br { bottom: 0; right: 0; border-left: none; border-top: none; border-bottom-right-radius: 14px; }

        /* Laser line */
        .scan-laser {
          position: absolute;
          width: 100%;
          height: 3px;
          background: linear-gradient(to right, transparent, var(--neon-primary), transparent);
          box-shadow: 0 0 10px var(--neon-primary);
          animation: laser-sweep 2s ease-in-out infinite;
          left: 0;
          z-index: 5;
        }

        .scan-frame.scanning-active .scan-laser {
          background: linear-gradient(to right, transparent, var(--neon-secondary), transparent);
          box-shadow: 0 0 10px var(--neon-secondary);
        }

        .scan-frame.success-active .scan-laser {
          background: linear-gradient(to right, transparent, #39ff14, transparent);
          box-shadow: 0 0 15px #39ff14;
          animation: none;
          top: 50%;
        }

        @keyframes laser-sweep {
          0% { top: 0%; }
          50% { top: 100%; }
          100% { top: 0%; }
        }

        .scan-video {
          width: 100%;
          height: 100%;
          object-fit: cover;
          transform: scaleX(-1);
        }

        /* QR Graphic representation */
        .gateway-qr-graphic {
          width: 130px;
          height: 130px;
          border: 1px solid rgba(255, 0, 127, 0.15);
          position: relative;
          padding: 8px;
          background: rgba(255, 255, 255, 0.01);
          border-radius: 8px;
        }

        .gateway-qr-corner {
          position: absolute;
          width: 22px;
          height: 22px;
          border: 3px solid var(--neon-primary);
          border-radius: 2px;
        }
        .g-qr-tl { top: 6px; left: 6px; border-right: none; border-bottom: none; }
        .g-qr-tr { top: 6px; right: 6px; border-left: none; border-bottom: none; }
        .g-qr-bl { bottom: 6px; left: 6px; border-right: none; border-top: none; }

        .gateway-qr-grid {
          width: 100%;
          height: 100%;
          display: grid;
          grid-template-columns: repeat(10, 1fr);
          grid-template-rows: repeat(10, 1fr);
          gap: 2.5px;
        }

        .qr-pixel {
          background: rgba(255, 255, 255, 0.04);
          border-radius: 1px;
        }

        .qr-pixel.active-pixel {
          background: var(--neon-primary);
          box-shadow: 0 0 6px var(--neon-primary);
        }

        /* Actions */
        .gateway-actions {
          display: flex;
          flex-direction: column;
          gap: 12px;
          width: 100%;
        }

        .gateway-btn {
          width: 100%;
          padding: 12px;
          font-size: 0.9rem;
          font-weight: 700;
          border-radius: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          cursor: pointer;
          transition: all 0.3s ease;
        }

        .progress-container {
          width: 100%;
          height: 6px;
          background: rgba(255, 255, 255, 0.08);
          border-radius: 10px;
          overflow: hidden;
          margin-top: 8px;
        }

        .progress-bar {
          height: 100%;
          background: var(--neon-secondary);
          box-shadow: var(--neon-secondary-glow);
        }

        .success-text {
          color: #39ff14;
          font-weight: 800;
          font-size: 0.95rem;
          text-shadow: 0 0 10px rgba(57, 255, 20, 0.4);
          letter-spacing: 1px;
          margin: 10px 0;
        }
      `}</style>
    </>
  );
}
