"use client";

import { useApp } from "@/context/AppContext";
import NeonCard from "@/components/NeonCard";
import Link from "next/link";
import { useState, useRef, useEffect, useCallback } from "react";

interface TemplateOption {
  id: string;
  name: string;
  desc: string;
  borderColor: string;
}

const TEMPLATES: TemplateOption[] = [
  { id: "polaroid-neon", name: "Polaroid Love", desc: "Kertas polaroid putih dengan tanda hati neon Rian & Salsa.", borderColor: "#ff007f" },
  { id: "romantic-arch", name: "Romantic Neon Arch", desc: "Kubah pelaminan neon menyala 'Just Married'.", borderColor: "#bd00ff" },
  { id: "gold-rings", name: "Gold Romance Rings", desc: "Bingkai emas elegan dengan sepasang cincin kawin.", borderColor: "#ffb800" },
  { id: "neon-hearts", name: "Glowing Hearts", desc: "Hati neon Rian & Salsa menyala bertumpuk.", borderColor: "#ff007f" },
];

const FILTERS = [
  { id: "none", name: "Original", color: "transparent" },
  { id: "neon-pink", name: "Cyber Pink", color: "#ff007f" },
  { id: "neon-cyan", name: "Future Cyan", color: "#00f0ff" },
  { id: "neon-gold", name: "Golden Hour", color: "#ffb800" },
  { id: "neon-green", name: "Acid Green", color: "#39ff14" },
];

export default function PhotoboothPage() {
  const { addPhoto, groomName, brideName, eventDate } = useApp();
  
  // States
  const [selectedTemplate, setSelectedTemplate] = useState("polaroid-neon");
  const [selectedFilter, setSelectedFilter] = useState("none");
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [hasCamera, setHasCamera] = useState(true);
  const [cameraActive, setCameraActive] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null); // final image with frame (base64)
  const [rawImage, setRawImage] = useState<string | null>(null); // uploaded or camera captured image before frame
  const [isCapturing, setIsCapturing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  
  // Guest info for direct gallery post
  const [guestName, setGuestName] = useState("");
  const [wishes, setWishes] = useState("");
  const [isPosted, setIsPosted] = useState(false);
  const [isPosting, setIsPosting] = useState(false);

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Stop camera stream
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  }, []);

  // Start camera stream
  const startCamera = useCallback(async () => {
    stopCamera();
    setRawImage(null);
    setCapturedImage(null);
    setErrorMessage("");
    
    try {
      const constraints = {
        video: {
          facingMode: facingMode,
          width: { ideal: 800 },
          height: { ideal: 800 },
          aspectRatio: 1
        },
        audio: false
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setCameraActive(true);
        setHasCamera(true);
      }
    } catch (err) {
      console.error("Camera access error:", err);
      setHasCamera(false);
      setCameraActive(false);
      setErrorMessage("Kamera tidak dapat diakses. Gunakan opsi upload foto di bawah.");
    }
  }, [facingMode, stopCamera]);

  // Handle camera toggle
  const toggleFacingMode = () => {
    setFacingMode((prev) => (prev === "user" ? "environment" : "user"));
  };

  // Run camera on mount
  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
    };
  }, [startCamera, stopCamera]);

  // Handle image upload fallback
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setErrorMessage("Silakan upload file gambar saja.");
      return;
    }

    stopCamera();
    setErrorMessage("");
    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) {
        setRawImage(event.target.result as string);
        setCapturedImage(null);
      }
    };
    reader.readAsDataURL(file);
  };

  // Trigger file upload click
  const triggerFileUpload = () => {
    fileInputRef.current?.click();
  };

  // Canvas Frame Drawing Engine
  const generateFramedPhoto = useCallback((source: HTMLVideoElement | HTMLImageElement, isVideo: boolean) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Dimensions
    const size = 800;
    const padding = 45;
    const bottomSpace = selectedTemplate === "polaroid-neon" ? 150 : 45;
    
    canvas.width = size;
    canvas.height = size + bottomSpace - padding;

    const width = canvas.width;
    const height = canvas.height;

    // 1. Draw Frame Border Background
    if (selectedTemplate === "polaroid-neon") {
      ctx.fillStyle = "#ffffff"; // polaroid classic white
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.fillStyle = "#060310"; // dark elegant cosmic background
      ctx.fillRect(0, 0, width, height);
    }

    const imgX = padding;
    const imgY = padding;
    const imgWidth = width - (padding * 2);
    const imgHeight = height - padding - bottomSpace;

    // 2. Draw Captured Photo with dynamic filters inside image box clip
    ctx.save();
    ctx.beginPath();
    ctx.rect(imgX, imgY, imgWidth, imgHeight);
    ctx.clip();
    
    if (selectedFilter === "neon-pink") {
      ctx.filter = "brightness(0.9) contrast(1.2) saturate(1.4)";
    } else if (selectedFilter === "neon-cyan") {
      ctx.filter = "brightness(0.9) contrast(1.25) saturate(1.3)";
    } else if (selectedFilter === "neon-gold") {
      ctx.filter = "brightness(0.9) contrast(1.15) saturate(1.45)";
    } else if (selectedFilter === "neon-green") {
      ctx.filter = "brightness(0.85) contrast(1.3) saturate(1.5)";
    } else {
      ctx.filter = "none";
    }

    // Draw Source
    if (isVideo) {
      const video = source as HTMLVideoElement;
      const minDim = Math.min(video.videoWidth, video.videoHeight);
      const sx = (video.videoWidth - minDim) / 2;
      const sy = (video.videoHeight - minDim) / 2;
      ctx.drawImage(video, sx, sy, minDim, minDim, imgX, imgY, imgWidth, imgHeight);
    } else {
      const img = source as HTMLImageElement;
      ctx.drawImage(img, imgX, imgY, imgWidth, imgHeight);
    }
    
    ctx.filter = "none";
    ctx.restore();

    // 3. Draw Overlay Neon Color Tint Filters (mix-blend-modes)
    if (selectedFilter !== "none") {
      ctx.save();
      ctx.beginPath();
      ctx.rect(imgX, imgY, imgWidth, imgHeight);
      ctx.clip();
      
      if (selectedFilter === "neon-pink") {
        ctx.fillStyle = "#ff007f";
        ctx.globalAlpha = 0.5;
        ctx.globalCompositeOperation = "color";
        ctx.fillRect(imgX, imgY, imgWidth, imgHeight);
      } else if (selectedFilter === "neon-cyan") {
        ctx.fillStyle = "#00f0ff";
        ctx.globalAlpha = 0.5;
        ctx.globalCompositeOperation = "color";
        ctx.fillRect(imgX, imgY, imgWidth, imgHeight);
      } else if (selectedFilter === "neon-gold") {
        ctx.fillStyle = "#ffb800";
        ctx.globalAlpha = 0.45;
        ctx.globalCompositeOperation = "overlay";
        ctx.fillRect(imgX, imgY, imgWidth, imgHeight);
      } else if (selectedFilter === "neon-green") {
        ctx.fillStyle = "#39ff14";
        ctx.globalAlpha = 0.45;
        ctx.globalCompositeOperation = "color";
        ctx.fillRect(imgX, imgY, imgWidth, imgHeight);
      }
      ctx.restore();
    }

    // 4. Draw Custom Premium Neon Wedding Overlays
    
    // Helper to draw realistic multi-layered neon glowing lines
    const drawNeonLine = (x1: number, y1: number, x2: number, y2: number, color: string, thickness: number) => {
      ctx.save();
      ctx.lineCap = "round";
      
      // Layer 1: Ambient outer blur
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
      ctx.lineWidth = thickness * 2.8;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // Layer 2: Main glowing color
      ctx.shadowBlur = 8;
      ctx.lineWidth = thickness * 1.5;
      ctx.stroke();

      // Layer 3: Hot white center core
      ctx.shadowBlur = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = thickness * 0.4;
      ctx.stroke();

      ctx.restore();
    };

    // Helper to draw realistic glowing neon arc
    const drawNeonArc = (cx: number, cy: number, r: number, start: number, end: number, color: string, thickness: number) => {
      ctx.save();
      ctx.lineCap = "round";

      // Layer 1: Ambient blur
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
      ctx.lineWidth = thickness * 2.8;
      ctx.beginPath();
      ctx.arc(cx, cy, r, start, end);
      ctx.stroke();

      // Layer 2: Glowing color
      ctx.shadowBlur = 8;
      ctx.lineWidth = thickness * 1.5;
      ctx.stroke();

      // Layer 3: White core
      ctx.shadowBlur = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = thickness * 0.4;
      ctx.stroke();

      ctx.restore();
    };

    // Helper to draw neon text on canvas
    const drawNeonText = (text: string, tx: number, ty: number, fontStr: string, color: string, shadowSize = 8) => {
      ctx.save();
      ctx.textAlign = "center";
      ctx.font = fontStr;

      // Layer 1: Soft blur
      ctx.shadowColor = color;
      ctx.shadowBlur = shadowSize * 2.2;
      ctx.fillStyle = color;
      ctx.fillText(text, tx, ty);

      // Layer 2: Glow body
      ctx.shadowBlur = shadowSize;
      ctx.fillText(text, tx, ty);

      // Layer 3: White text core
      ctx.shadowBlur = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.strokeText(text, tx, ty);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, tx, ty);

      ctx.restore();
    };

    ctx.save();
    
    if (selectedTemplate === "polaroid-neon") {
      // Polaroid inner shadow
      ctx.strokeStyle = "rgba(0,0,0,0.12)";
      ctx.lineWidth = 2;
      ctx.strokeRect(imgX, imgY, imgWidth, imgHeight);

      // Draw aesthetic polaroid tape on top corners
      const drawTape = (tx: number, ty: number, rotateAngle: number) => {
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(rotateAngle);
        ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
        ctx.fillRect(-35, -10, 70, 20);
        ctx.strokeStyle = "rgba(0,0,0,0.05)";
        ctx.lineWidth = 1;
        ctx.strokeRect(-35, -10, 70, 20);
        ctx.restore();
      };
      drawTape(imgX + 30, imgY + 15, -Math.PI / 15);
      drawTape(imgX + imgWidth - 30, imgY + 15, Math.PI / 15);

      // Neon cursive text at bottom center (Rian & Salsa)
      drawNeonText(
        `${groomName} 💖 ${brideName}`, 
        width / 2, 
        height - 75, 
        "italic 700 36px 'Lexend', sans-serif", 
        "#ff007f"
      );

      // Subtitle (Using actual Google font Outfit loaded via document)
      ctx.fillStyle = "#555555";
      ctx.font = "italic 600 18px 'Lexend', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("~ captured with love ~", width / 2, height - 40);

    } else if (selectedTemplate === "romantic-arch") {
      const archColor = "#bd00ff";
      
      // Thin outline border
      ctx.strokeStyle = "rgba(189, 0, 255, 0.2)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(padding, padding, imgWidth, imgHeight);

      // Draw Glowing Neon Dome Arch
      const archRadius = imgWidth / 2 - 35;
      const startX = width / 2 - archRadius;
      const endX = width / 2 + archRadius;
      const startY = imgY + archRadius + 15;

      // Arc dome
      drawNeonArc(width / 2, startY, archRadius, Math.PI, 0, archColor, 3.5);

      // Left and right pillars
      drawNeonLine(startX, startY, startX, imgY + imgHeight - 10, archColor, 3.5);
      drawNeonLine(endX, startY, endX, imgY + imgHeight - 10, archColor, 3.5);

      // Just Married neon sign
      drawNeonText(
        "JUST MARRIED", 
        width / 2, 
        imgY + 50, 
        "800 20px 'Lexend', sans-serif", 
        "#00f0ff"
      );

      // Groom & Bride bottom text
      drawNeonText(
        `The Wedding of ${groomName} & ${brideName}`, 
        width / 2, 
        height - 25, 
        "italic 700 24px 'Lexend', sans-serif", 
        "#ff007f"
      );

    } else if (selectedTemplate === "gold-rings") {
      const goldColor = "#ffb800";
      
      // Draw double gold borders
      ctx.strokeStyle = goldColor;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(padding + 6, padding + 6, imgWidth - 12, imgHeight - 12);
      
      ctx.strokeStyle = goldColor;
      ctx.lineWidth = 3.5;
      ctx.strokeRect(padding, padding, imgWidth, imgHeight);

      // Corners Sparkles
      const drawSparkle = (cx: number, cy: number, r: number) => {
        ctx.save();
        ctx.beginPath();
        ctx.fillStyle = goldColor;
        ctx.shadowColor = goldColor;
        ctx.shadowBlur = 12;
        for (let i = 0; i < 4; i++) {
          ctx.lineTo(cx + Math.cos((i * Math.PI) / 2) * r, cy + Math.sin((i * Math.PI) / 2) * r);
          ctx.lineTo(cx + Math.cos((i * Math.PI) / 2 + Math.PI / 4) * (r / 3), cy + Math.sin((i * Math.PI) / 2 + Math.PI / 4) * (r / 3));
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      };
      drawSparkle(padding + 25, padding + 25, 18);
      drawSparkle(width - padding - 25, padding + 25, 18);

      // Intersecting Neon Gold Rings at bottom center
      const rx = width / 2;
      const ry = height - 70;
      
      // Left Ring
      drawNeonArc(rx - 13, ry, 16, 0, Math.PI * 2, goldColor, 3.5);
      // Right Ring
      drawNeonArc(rx + 13, ry, 16, 0, Math.PI * 2, goldColor, 3.5);

      // Elegant Wedding calligraphy bottom text
      drawNeonText(
        `${groomName} & ${brideName}`, 
        width / 2, 
        height - 25, 
        "italic 700 26px 'Lexend', sans-serif", 
        goldColor
      );

    } else if (selectedTemplate === "neon-hearts") {
      const heartColor = "#ff007f";
      
      // Border lines
      ctx.strokeStyle = "rgba(255, 0, 127, 0.25)";
      ctx.lineWidth = 2;
      ctx.strokeRect(padding, padding, imgWidth, imgHeight);
      
      // Glowing neon hearts paths in bottom corners
      const drawGlowingHeart = (cx: number, cy: number, w: number, angle: number) => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        
        ctx.beginPath();
        // outer shadow path
        ctx.strokeStyle = heartColor;
        ctx.shadowColor = heartColor;
        ctx.shadowBlur = 18;
        ctx.lineWidth = 8;
        
        const pathHeart = () => {
          ctx.moveTo(0, -w / 4);
          ctx.bezierCurveTo(-w / 2, -w / 2, -w, -w / 6, -w, w / 4);
          ctx.bezierCurveTo(-w, w * 0.7, 0, w, 0, w);
          ctx.bezierCurveTo(0, w, w, w * 0.7, w, w / 4);
          ctx.bezierCurveTo(w, -w / 6, w / 2, -w / 2, 0, -w / 4);
        };
        
        pathHeart();
        ctx.stroke();

        // glowing color path
        ctx.shadowBlur = 8;
        ctx.lineWidth = 4;
        ctx.stroke();

        // hot white center
        ctx.shadowBlur = 2;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.2;
        ctx.stroke();
        
        ctx.restore();
      };

      // Bottom Left Hearts
      drawGlowingHeart(padding + 35, height - padding - 45, 14, -Math.PI / 12);
      drawGlowingHeart(padding + 55, height - padding - 35, 9, Math.PI / 18);

      // Bottom Right Hearts
      drawGlowingHeart(width - padding - 35, height - padding - 45, 14, Math.PI / 12);
      drawGlowingHeart(width - padding - 55, height - padding - 35, 9, -Math.PI / 18);

      // Wedding plaque text
      drawNeonText(
        `${groomName.toUpperCase()} 💖 ${brideName.toUpperCase()}`, 
        width / 2, 
        height - 25, 
        "800 22px 'Lexend', sans-serif", 
        "#ff007f"
      );
    }

    ctx.restore();

    // 5. Export canvas data to state
    const finalDataUrl = canvas.toDataURL("image/png");
    setCapturedImage(finalDataUrl);
  }, [selectedTemplate, selectedFilter, groomName, brideName, eventDate]);

  // Capture photo countdown implementation
  const capturePhoto = () => {
    if (countdown !== null || isCapturing) return;

    // Begin 3s Countdown
    let currentCountdown = 3;
    setCountdown(currentCountdown);

    const interval = setInterval(() => {
      currentCountdown -= 1;
      if (currentCountdown > 0) {
        setCountdown(currentCountdown);
      } else {
        clearInterval(interval);
        setCountdown(null);
        setIsCapturing(true);

        // Flash screen overlay & capture
        setTimeout(() => {
          if (videoRef.current && cameraActive) {
            generateFramedPhoto(videoRef.current, true);
          }
          setIsCapturing(false);
        }, 150);
      }
    }, 1000);
  };

  // Compile frame from uploaded raw file
  useEffect(() => {
    if (rawImage) {
      const img = new Image();
      img.src = rawImage;
      img.onload = () => {
        generateFramedPhoto(img, false);
      };
    }
  }, [rawImage, selectedTemplate, selectedFilter, generateFramedPhoto]);

  // Reset state to retake
  const handleRetake = () => {
    setCapturedImage(null);
    setRawImage(null);
    setIsPosted(false);
    setGuestName("");
    setWishes("");
    startCamera();
  };

  // Download framed PNG
  const downloadFramedPhoto = () => {
    if (!capturedImage) return;
    const link = document.createElement("a");
    link.href = capturedImage;
    link.download = `photobooth-${groomName}-${brideName}-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Submit to live wishes wall
  const handlePostToGallery = (e: React.FormEvent) => {
    e.preventDefault();
    if (!guestName.trim() || !capturedImage) return;

    setIsPosting(true);
    addPhoto(guestName, wishes, capturedImage, "none"); // none as filter is already flattened into canvas
    setIsPosting(false);
    setIsPosted(true);
  };

  return (
    <div className="photobooth-page-container container">
      <div className="neon-orb-1" />

      <header className="photobooth-header">
        <h1 className="photobooth-title">
          Digital <span className="neon-text-primary">Photobooth</span>
        </h1>
        <p className="photobooth-subtitle">
          Ambil foto keseruan Anda dengan bingkai neon pernikahan eksklusif. Unduh dan bagikan ke galeri!
        </p>
      </header>

      <div className="photobooth-layout">
        {/* Left Column: Camera Viewport / Captured Preview */}
        <div className="viewport-col">
          <NeonCard glowColor="primary" className="camera-card">
            <div className={`viewport-box ${isCapturing ? "flash" : ""}`}>
              {/* Captured Frame Preview */}
              {capturedImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={capturedImage} alt="Captured" className="captured-preview-img" />
              ) : rawImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={rawImage} alt="Raw upload" className="captured-preview-img" />
              ) : (
                // Live Video Stream
                <div className="video-stream-container">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    className="webcam-video"
                    style={{ transform: facingMode === "user" ? "scaleX(-1)" : "none" }}
                  />
                  {!cameraActive && (
                    <div className="camera-placeholder">
                      <span className="camera-icon">📷</span>
                      <p>Kamera mati atau izin ditolak</p>
                    </div>
                  )}
                </div>
              )}

              {/* Countdown overlay */}
              {countdown !== null && (
                <div className="countdown-overlay">
                  <span className="countdown-number-glow neon-text-primary">{countdown}</span>
                </div>
              )}
            </div>

            {/* Quick Camera controls */}
            {!capturedImage && !rawImage && (
              <div className="camera-quick-controls">
                {hasCamera && cameraActive && (
                  <button className="btn-quick" onClick={toggleFacingMode} title="Putar Kamera">
                    🔄 Kamera {facingMode === "user" ? "Belakang" : "Depan"}
                  </button>
                )}
                <button className="btn-quick" onClick={triggerFileUpload} title="Upload Foto">
                  📁 Upload File Foto
                </button>
              </div>
            )}
            
            {/* Hidden Input file fallback */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept="image/*"
              style={{ display: "none" }}
            />
          </NeonCard>
        </div>

        {/* Right Column: Templates, Filters, and Form Settings */}
        <div className="controls-col">
          {!capturedImage ? (
            /* Choose template side panel */
            <NeonCard glowColor="secondary">
              <div className="settings-panel-card-inner">
                <h2 className="section-heading neon-text-secondary">🎨 Bingkai Pernikahan</h2>
                <div className="templates-selector-list">
                  {TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.id}
                      className={`template-item-btn glass-panel ${selectedTemplate === tpl.id ? "active" : ""}`}
                      onClick={() => setSelectedTemplate(tpl.id)}
                      style={{ "--item-accent": tpl.borderColor } as React.CSSProperties}
                    >
                      <span className="template-indicator-dot" />
                      <div className="template-meta">
                        <h4 className="template-name">{tpl.name}</h4>
                        <p className="template-desc">{tpl.desc}</p>
                      </div>
                    </button>
                  ))}
                </div>

                {/* Neon color filters section */}
                <div className="filter-section" style={{ marginTop: "10px" }}>
                  <h3 className="filter-heading neon-text-primary">✨ Filter Warna Neon</h3>
                  <div className="filters-grid-booth">
                    {FILTERS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`filter-btn-booth ${selectedFilter === opt.id ? "active" : ""}`}
                        onClick={() => setSelectedFilter(opt.id)}
                        style={{ "--btn-accent": opt.color } as React.CSSProperties}
                      >
                        {opt.name}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Trigger Capture Button */}
                {cameraActive && !rawImage ? (
                  <button className="btn btn-primary shoot-btn" onClick={capturePhoto}>
                    📸 Ambil Foto (3s Hitung Mundur)
                  </button>
                ) : rawImage ? (
                  <div className="upload-active-actions">
                    <p className="file-active-info">✓ Foto berhasil di-upload. Pilih bingkai & filter diatas!</p>
                    <button className="btn btn-secondary retake-btn" onClick={handleRetake}>
                      🗑️ Hapus Foto
                    </button>
                  </div>
                ) : (
                  <button className="btn btn-primary shoot-btn" onClick={triggerFileUpload}>
                    📁 Upload Foto untuk Mulai
                  </button>
                )}
              </div>
            </NeonCard>
          ) : (
            /* Post Captured Frame Form Panel */
            <NeonCard glowColor="secondary">
              <div className="settings-panel-card-inner">
                {!isPosted ? (
                  <>
                    <h2 className="section-heading neon-text-secondary">Simpan & Bagikan</h2>
                    <div className="success-action-buttons">
                      <button className="btn btn-primary save-btn-large" onClick={downloadFramedPhoto}>
                        📥 Download Foto Bingkai
                      </button>
                      <button className="btn btn-flat retake-btn" onClick={handleRetake}>
                        🔄 Ambil Ulang Foto
                      </button>
                    </div>

                    <div className="form-divider" />

                    {/* Send to live gallery */}
                    <form onSubmit={handlePostToGallery} className="gallery-post-form">
                      <h3 className="sub-heading">Kirim Langsung ke Galeri Live</h3>
                      <p className="sub-heading-desc">Bagikan ke layar panggung pernikahan agar semua tamu dapat melihat keseruan Anda.</p>
                      
                      <div className="form-group">
                        <label className="form-label" htmlFor="boothGuestName">
                          Nama Anda
                        </label>
                        <input
                          id="boothGuestName"
                          type="text"
                          className="input-field"
                          placeholder="Contoh: Budi & Rina"
                          value={guestName}
                          onChange={(e) => setGuestName(e.target.value)}
                          required
                        />
                      </div>

                      <div className="form-group">
                        <label className="form-label" htmlFor="boothWishes">
                          Ucapan Selamat
                        </label>
                        <textarea
                          id="boothWishes"
                          className="input-field"
                          placeholder="Doa terbaik Anda..."
                          value={wishes}
                          onChange={(e) => setWishes(e.target.value)}
                          rows={2}
                        />
                      </div>

                      <button
                        type="submit"
                        className="btn btn-secondary submit-post-btn"
                        disabled={isPosting || !guestName.trim()}
                      >
                        {isPosting ? "Mengirim..." : "✨ Kirim ke Galeri Live"}
                      </button>
                    </form>
                  </>
                ) : (
                  /* Post Success Panel */
                  <div className="booth-post-success">
                    <span className="success-icon-badge">✨</span>
                    <h2 className="neon-text-secondary">Terposting di Galeri!</h2>
                    <p>Foto berbingkai Anda sekarang sudah tayang di galeri dan layar proyektor.</p>
                    
                    <div className="success-nav-buttons">
                      <Link href="/gallery" className="btn btn-primary">
                        🖼️ Lihat Galeri Live
                      </Link>
                      <button className="btn btn-secondary" onClick={handleRetake}>
                        📸 Ambil Foto Baru
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </NeonCard>
          )}
        </div>
      </div>

      <style jsx>{`
        .photobooth-page-container {
          padding: 140px 20px 80px !important;
          display: flex;
          flex-direction: column;
          gap: 40px;
          position: relative;
        }

        .neon-orb-1 {
          position: absolute;
          width: 300px;
          height: 300px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(255, 0, 127, 0.12) 0%, rgba(0, 0, 0, 0) 70%);
          top: 10%;
          left: 50%;
          transform: translate(-50%, -50%);
          z-index: -1;
          filter: blur(40px);
        }

        .photobooth-header {
          text-align: center;
          margin-top: 60px;
        }

        .photobooth-title {
          font-family: var(--font-serif);
          font-size: 2.8rem;
          font-weight: 700;
          margin-bottom: 10px;
        }

        .photobooth-subtitle {
          font-size: 1.1rem;
          color: var(--text-muted);
          max-width: 650px;
          margin: 0 auto;
        }

        /* Layout */
        .photobooth-layout {
          display: grid;
          grid-template-columns: 1.1fr 1fr;
          gap: 40px;
          align-items: start;
        }

        .viewport-col {
          display: flex;
          flex-direction: column;
          width: 100%;
        }

        .camera-card {
          width: 100%;
          overflow: hidden;
          border-radius: 16px;
        }

        .viewport-box {
          position: relative;
          width: 100%;
          aspect-ratio: 1;
          background: #000;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          transition: background-color 0.1s ease;
        }

        .viewport-box.flash {
          background-color: #ffffff;
        }

        .captured-preview-img {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }

        .video-stream-container {
          position: relative;
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .webcam-video {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .camera-placeholder {
          position: absolute;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          color: var(--text-muted);
          text-align: center;
          padding: 20px;
        }

        .camera-icon {
          font-size: 3rem;
        }

        /* Countdown Overlay */
        .countdown-overlay {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(7, 4, 18, 0.4);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 5;
        }

        .countdown-number-glow {
          font-size: 8rem;
          font-weight: 800;
          animation: pop-count 1s ease-in-out infinite;
        }

        @keyframes pop-count {
          0% { transform: scale(0.6); opacity: 0; }
          50% { transform: scale(1.1); opacity: 1; }
          100% { transform: scale(1.3); opacity: 0; }
        }

        /* Camera Controls */
        .camera-quick-controls {
          display: flex;
          justify-content: center;
          gap: 12px;
          padding: 16px;
          background: rgba(0, 0, 0, 0.3);
          border-top: 1px solid rgba(255, 255, 255, 0.05);
        }

        .btn-quick {
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #fff;
          padding: 8px 16px;
          border-radius: 20px;
          cursor: pointer;
          font-size: 0.85rem;
          font-weight: 600;
          transition: all 0.2s ease;
        }

        .btn-quick:hover {
          background: rgba(255, 255, 255, 0.12);
        }

        /* Settings Card Right Panel */
        .settings-panel-card-inner {
          padding: 30px;
          display: flex;
          flex-direction: column;
          gap: 24px;
          width: 100%;
        }

        .section-heading {
          font-size: 1.3rem;
          font-weight: 700;
        }

        .sub-heading {
          font-size: 1rem;
          font-weight: 700;
          color: #fff;
        }

        .sub-heading-desc {
          font-size: 0.8rem;
          color: var(--text-muted);
          margin-bottom: 8px;
        }

        /* Filter Section inside booth controls */
        .filter-heading {
          font-size: 1.05rem;
          font-weight: 700;
          margin-bottom: 12px;
        }

        .filters-grid-booth {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 6px;
        }

        .filter-btn-booth {
          padding: 8px 4px;
          border-radius: 8px;
          font-size: 0.75rem;
          font-weight: 700;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: #a9a4b8;
          cursor: pointer;
          transition: all 0.3s ease;
          text-align: center;
        }

        .filter-btn-booth:hover {
          color: #fff;
          background: rgba(255, 255, 255, 0.06);
        }

        .filter-btn-booth.active {
          color: #fff;
          background: rgba(255, 255, 255, 0.05);
          border-color: var(--btn-accent, var(--neon-primary));
          box-shadow: 0 0 8px var(--btn-accent, var(--neon-primary));
        }

        /* Templates Grid list */
        .templates-selector-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .template-item-btn {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 12px 18px;
          border-radius: 12px;
          text-align: left;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          cursor: pointer;
          transition: all 0.3s ease;
          width: 100%;
        }

        .template-item-btn:hover {
          background: rgba(255, 255, 255, 0.06);
          border-color: rgba(255, 255, 255, 0.12);
        }

        .template-item-btn.active {
          background: rgba(255, 255, 255, 0.08);
          border-color: var(--item-accent, var(--neon-secondary));
          box-shadow: 0 0 10px rgba(255, 255, 255, 0.02), 0 0 8px var(--item-accent, var(--neon-secondary));
        }

        .template-indicator-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.2);
          transition: all 0.2s ease;
          flex-shrink: 0;
        }

        .template-item-btn.active .template-indicator-dot {
          background: var(--item-accent, var(--neon-secondary));
          box-shadow: 0 0 8px var(--item-accent, var(--neon-secondary));
          transform: scale(1.3);
        }

        .template-meta {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .template-name {
          font-size: 0.95rem;
          font-weight: 700;
          color: #fff;
        }

        .template-desc {
          font-size: 0.75rem;
          color: var(--text-muted);
        }

        .shoot-btn {
          width: 100%;
          height: 48px;
          margin-top: 10px;
        }

        .upload-active-actions {
          display: flex;
          flex-direction: column;
          gap: 12px;
          text-align: center;
        }

        .file-active-info {
          font-size: 0.9rem;
          color: #39ff14;
          font-weight: 600;
        }

        /* Captured Actions Form styling */
        .success-action-buttons {
          display: flex;
          gap: 12px;
        }

        .save-btn-large {
          flex: 1.3;
          height: 44px;
        }

        .retake-btn {
          flex: 1;
          height: 44px;
        }

        .form-divider {
          height: 1px;
          background: rgba(255, 255, 255, 0.1);
          margin: 8px 0;
        }

        .gallery-post-form {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .form-group {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .form-label {
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--text-muted);
        }

        .submit-post-btn {
          height: 44px;
          font-size: 0.95rem;
        }

        /* Post Success Panel styling */
        .booth-post-success {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          gap: 16px;
          padding: 20px 0;
        }

        .success-icon-badge {
          width: 60px;
          height: 60px;
          border-radius: 50%;
          background: rgba(0, 240, 255, 0.1);
          color: #00f0ff;
          border: 1px solid #00f0ff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1.8rem;
          box-shadow: 0 0 15px rgba(0, 240, 255, 0.2);
        }

        .booth-post-success p {
          font-size: 0.9rem;
          color: var(--text-muted);
          line-height: 1.5;
          max-width: 280px;
        }

        .success-nav-buttons {
          display: flex;
          flex-direction: column;
          gap: 10px;
          width: 100%;
          margin-top: 10px;
        }

        .success-nav-buttons .btn {
          width: 100%;
          height: 44px;
        }

        /* Responsive Layouts */
        @media (max-width: 992px) {
          .photobooth-layout {
            grid-template-columns: 1fr;
            gap: 30px;
          }
          
          .viewport-col {
            max-width: 500px;
            margin: 0 auto;
          }

          .controls-col {
            max-width: 500px;
            margin: 0 auto;
            width: 100%;
          }
        }

        @media (max-width: 768px) {
          .photobooth-page-container {
            padding: 100px 16px 60px !important;
          }
          .photobooth-header {
            margin-top: 20px !important;
          }
          .photobooth-title {
            font-size: 2.2rem;
          }
          .settings-panel-card {
            padding: 20px;
          }
        }
      `}</style>
    </div>
  );
}
