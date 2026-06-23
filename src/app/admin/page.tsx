"use client";

import { useApp, NeonTheme } from "@/context/AppContext";
import NeonCard from "@/components/NeonCard";
import { useState, useEffect } from "react";

export default function AdminPage() {
  const {
    groomName,
    brideName,
    eventDate,
    neonTheme,
    photos,
    deletePhoto,
    updateEventDetails,
    updateTheme,
    resetToDefault,
  } = useApp();

  // Navigation tab state
  const [activeTab, setActiveTab] = useState<"moderation" | "settings" | "qrs">("moderation");

  // Local state for event settings form
  const [groom, setGroom] = useState(groomName);
  const [bride, setBride] = useState(brideName);
  const [date, setDate] = useState(eventDate);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Sync state if context changes (e.g. from preset activation)
  useEffect(() => {
    setGroom(groomName);
    setBride(brideName);
    setDate(eventDate);
  }, [groomName, brideName, eventDate]);

  // Handle saving wedding info
  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    updateEventDetails(groom, bride, date);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  // State for custom QR generator
  const [customGroom, setCustomGroom] = useState("");
  const [customBride, setCustomBride] = useState("");
  const [customDate, setCustomDate] = useState("2026-08-08");
  const [customTheme, setCustomTheme] = useState<NeonTheme>("pink-cyber");
  const [customQrUrl, setCustomQrUrl] = useState("");

  // Base URL helper
  const getBaseOrigin = () => {
    if (typeof window !== "undefined") {
      return window.location.origin;
    }
    return "http://localhost:3000";
  };

  // Generate QR image API URL based on inputs
  const getQrCodeApiUrl = (groomVal: string, brideVal: string, dateVal: string, themeVal: NeonTheme) => {
    const origin = getBaseOrigin();
    const targetUrl = `${origin}/?groom=${encodeURIComponent(groomVal)}&bride=${encodeURIComponent(brideVal)}&date=${dateVal}&theme=${themeVal}`;
    
    // Choose QR foreground color based on theme
    let colorHex = "ff007f"; // Cyber Pink
    if (themeVal === "cyan-future") colorHex = "00f0ff";
    if (themeVal === "gold-luxury") colorHex = "ffb800";
    if (themeVal === "acid-lime") colorHex = "39ff14";

    // Deep slate background color (#0e0a1f)
    const bgHex = "0e0a1f";
    
    return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(targetUrl)}&color=${colorHex}&bgcolor=${bgHex}&margin=15`;
  };

  // Preset Weddings details
  const PRESET_WEDDINGS = [
    {
      id: "preset-1",
      groom: "Rian",
      bride: "Salsa",
      date: "2026-08-08",
      theme: "pink-cyber" as NeonTheme,
      themeName: "Cyber Pink",
      themeColor: "#ff007f",
      description: "Default Cyber Pink theme with vibrant magenta glows."
    },
    {
      id: "preset-2",
      groom: "Aditya",
      bride: "Rara",
      date: "2026-09-12",
      theme: "gold-luxury" as NeonTheme,
      themeName: "Golden Glow",
      themeColor: "#ffb800",
      description: "Elegant golden theme with deep orange sunset highlights."
    },
    {
      id: "preset-3",
      groom: "Fahmi",
      bride: "Amanda",
      date: "2026-10-18",
      theme: "cyan-future" as NeonTheme,
      themeName: "Future Cyan",
      themeColor: "#00f0ff",
      description: "Futuristic neon cyan and deep violet glow combination."
    }
  ];

  const handleActivatePreset = (p: typeof PRESET_WEDDINGS[0]) => {
    updateEventDetails(p.groom, p.bride, p.date);
    updateTheme(p.theme);
    alert(`Pernikahan ${p.groom} & ${p.bride} berhasil diaktifkan secara global!`);
  };

  // Helper for themes formatting (Tab 2)
  const themesList: { id: NeonTheme; name: string; desc: string; colors: string[] }[] = [
    {
      id: "pink-cyber",
      name: "Cyber Pink",
      desc: "Neon magenta dan neon cyan elektrik.",
      colors: ["#ff007f", "#00f0ff"],
    },
    {
      id: "cyan-future",
      name: "Future Cyan",
      desc: "Neon cyan futuristik dan purple ultraviolet.",
      colors: ["#00f0ff", "#bd00ff"],
    },
    {
      id: "gold-luxury",
      name: "Golden Glow",
      desc: "Emas mewah berpendar dengan warna jingga senja.",
      colors: ["#ffb800", "#ff3c00"],
    },
    {
      id: "acid-lime",
      name: "Acid Lime",
      desc: "Hijau neon elektrik dipadukan dengan cyan.",
      colors: ["#39ff14", "#00f0ff"],
    },
  ];

  return (
    <div className="admin-page-container container">
      <header className="admin-header">
        <h1 className="admin-title">
          Dashboard <span className="neon-text-primary">Admin</span>
        </h1>
        <p className="admin-subtitle">
          Nakha Wedding Invitation & Live Gallery Management System
        </p>
      </header>

      {/* Tabs navigation */}
      <div className="admin-tabs-nav glass-panel">
        <button
          className={`tab-nav-btn ${activeTab === "moderation" ? "active" : ""}`}
          onClick={() => setActiveTab("moderation")}
        >
          🛡️ Moderasi Foto
        </button>
        <button
          className={`tab-nav-btn ${activeTab === "settings" ? "active" : ""}`}
          onClick={() => setActiveTab("settings")}
        >
          ⚙️ Pengaturan & Tema
        </button>
        <button
          className={`tab-nav-btn ${activeTab === "qrs" ? "active" : ""}`}
          onClick={() => setActiveTab("qrs")}
        >
          ✉️ Generator QR Undangan
        </button>
      </div>

      {/* Stats summary row (Always visible for quick stats) */}
      <div className="stats-row">
        <NeonCard glowColor="primary" className="stat-card">
          <div className="stat-card-inner">
            <span className="stat-value neon-text-primary">{photos.length}</span>
            <span className="stat-label">Total Foto Diunggah</span>
          </div>
        </NeonCard>
        
        <NeonCard glowColor="secondary" className="stat-card">
          <div className="stat-card-inner">
            <span className="stat-value neon-text-secondary" style={{ textTransform: "uppercase" }}>
              {neonTheme.replace("-", " ")}
            </span>
            <span className="stat-label">Tema Neon Aktif</span>
          </div>
        </NeonCard>

        <NeonCard glowColor="gold" className="stat-card">
          <div className="stat-card-inner">
            <span className="stat-value" style={{ color: "#ffb800", textShadow: "0 0 10px #ffb800" }}>
              {date.split("-").reverse().join(" / ")}
            </span>
            <span className="stat-label">Tanggal Aktif</span>
          </div>
        </NeonCard>
      </div>

      {/* TAB CONTENT AREAS */}
      <div className="admin-main-content">
        
        {/* TAB 1: PHOTO MODERATION */}
        {activeTab === "moderation" && (
          <NeonCard glowColor="primary" className="settings-section">
            <h2 className="section-heading neon-text-primary">
              <span className="heading-emoji">🛡️</span>
              <span>Moderasi Foto Tamu</span>
            </h2>
            <p className="settings-section-desc">
              Hapus foto atau ucapan yang kurang pantas dari para tamu agar tidak tayang di live gallery maupun proyektor panggung.
            </p>

            {photos.length > 0 ? (
              <div className="moderation-grid">
                {photos.map((photo) => (
                  <div key={photo.id} className="moderation-card-item glass-panel">
                    <div className={`moderation-card-thumb photo-container-filtered filter-${photo.filter}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={photo.photoUrl} alt="Guest Upload" className="moderation-card-img" />
                    </div>
                    
                    <div className="moderation-card-details">
                      <div className="moderation-card-meta">
                        <span className="moderation-card-guest">{photo.guestName}</span>
                        <span className="moderation-card-time">{photo.timestamp}</span>
                      </div>
                      <p className="moderation-card-wishes">"{photo.wishes}"</p>
                      
                      <div className="moderation-card-footer">
                        <div className="filter-badge-pill">
                          Filter: <span style={{ color: themesList.find(t => t.id === photo.filter)?.colors[0] || "#ff007f" }}>{photo.filter}</span>
                        </div>
                        <button
                          className="btn-moderation-delete"
                          onClick={() => {
                            if (confirm(`Apakah Anda yakin ingin menghapus foto dari "${photo.guestName}"?`)) {
                              deletePhoto(photo.id);
                            }
                          }}
                        >
                          🗑️ Hapus
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="moderation-empty">
                <span>📭</span>
                <p>Belum ada foto yang diunggah untuk pasangan {groomName} & {brideName}.</p>
              </div>
            )}
          </NeonCard>
        )}

        {/* TAB 2: WEDDING SETTINGS & THEMES */}
        {activeTab === "settings" && (
          <div className="settings-tab-grid">
            <div className="flex-col gap-24">
              {/* Event Details Card */}
              <NeonCard glowColor="primary" className="settings-section">
                <h2 className="section-heading neon-text-primary">
                  <span className="heading-emoji">⚙️</span>
                  <span>Pengaturan Pernikahan</span>
                </h2>
                <form onSubmit={handleSaveSettings} className="settings-form">
                  {saveSuccess && (
                    <div className="success-banner">
                      ✓ Perubahan berhasil disimpan secara global!
                    </div>
                  )}
                  
                  <div className="form-group">
                    <label className="form-label" htmlFor="groomInput">
                      Nama Mempelai Pria (Groom)
                    </label>
                    <input
                      id="groomInput"
                      type="text"
                      className="input-field"
                      value={groom}
                      onChange={(e) => setGroom(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="brideInput">
                      Nama Mempelai Wanita (Bride)
                    </label>
                    <input
                      id="brideInput"
                      type="text"
                      className="input-field"
                      value={bride}
                      onChange={(e) => setBride(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="dateInput">
                      Tanggal Pernikahan
                    </label>
                    <input
                      id="dateInput"
                      type="date"
                      className="input-field"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      required
                    />
                  </div>

                  <button type="submit" className="btn btn-primary save-btn">
                    Simpan Perubahan
                  </button>
                </form>
              </NeonCard>

              {/* Danger Zone Card */}
              <NeonCard glowColor="pink" className="settings-section danger-section">
                <h2 className="section-heading text-pink" style={{ color: "#ff007f", textShadow: "0 0 10px #ff007f" }}>
                  <span className="heading-emoji">⚠️</span>
                  <span>Zona Bahaya</span>
                </h2>
                <p className="settings-section-desc">
                  Tindakan destruktif di bawah ini bersifat permanen dan tidak dapat dibatalkan.
                </p>
                <div className="danger-actions">
                  <button
                    type="button"
                    className="btn btn-flat reset-btn"
                    onClick={() => {
                      if (confirm("Apakah Anda yakin ingin mereset data foto dan ucapan Rian & Salsa ke mock awal?")) {
                        resetToDefault();
                        setGroom("Rian");
                        setBride("Salsa");
                        setDate("2026-08-08");
                      }
                    }}
                  >
                    🔄 Reset Data Rian & Salsa ke Mock Awal
                  </button>
                </div>
              </NeonCard>
            </div>

            {/* Global Theme selector card */}
            <NeonCard glowColor="secondary" className="settings-section">
              <h2 className="section-heading neon-text-secondary">
                <span className="heading-emoji">🎨</span>
                <span>Tema Neon Global</span>
              </h2>
              <p className="settings-section-desc">
                Pilih palet warna neon utama. Ini secara otomatis memperbarui visual bercahaya di seluruh halaman utama, photobooth, slideshow proyektor, dan live gallery.
              </p>
              <div className="themes-grid">
                {themesList.map((theme) => (
                  <button
                    key={theme.id}
                    className={`theme-selector-btn glass-panel ${neonTheme === theme.id ? "active" : ""}`}
                    onClick={() => updateTheme(theme.id)}
                  >
                    <div className="theme-circles-preview">
                      <span className="circle" style={{ backgroundColor: theme.colors[0], boxShadow: `0 0 8px ${theme.colors[0]}` }} />
                      <span className="circle" style={{ backgroundColor: theme.colors[1], boxShadow: `0 0 8px ${theme.colors[1]}` }} />
                    </div>
                    <div className="theme-meta">
                      <span className="theme-name">{theme.name}</span>
                      <span className="theme-desc">{theme.desc}</span>
                    </div>
                  </button>
                ))}
              </div>
            </NeonCard>
          </div>
        )}

        {/* TAB 3: QR CODE & INVITATIONS */}
        {activeTab === "qrs" && (
          <div className="qrs-tab-layout">
            
            {/* Title explanation */}
            <div className="qrs-info-box glass-panel">
              <h3>Bagaimana cara kerja QR Code Multi-Pasangan?</h3>
              <p>
                Setiap QR code di bawah ini disisipkan parameter query URL unik (seperti <code>?groom=Aditya&bride=Rara...</code>).
                Ketika tamu memindai QR code tersebut, aplikasi secara otomatis menyesuaikan nama pengantin, tanggal acara, serta skema warna neon untuk pasangan tersebut!
              </p>
            </div>

            {/* Row of 3 presets */}
            <div className="presets-section">
              <h3 className="sub-section-title">3 QR Code Undangan Preset (Beda Orang & Tema)</h3>
              <div className="presets-grid">
                {PRESET_WEDDINGS.map((preset) => {
                  const qrImgUrl = getQrCodeApiUrl(preset.groom, preset.bride, preset.date, preset.theme);
                  const originUrl = getBaseOrigin();
                  const encodedLink = `${originUrl}/?groom=${encodeURIComponent(preset.groom)}&bride=${encodeURIComponent(preset.bride)}&date=${preset.date}&theme=${preset.theme}`;

                  return (
                    <NeonCard key={preset.id} glowColor={preset.theme === "pink-cyber" ? "pink" : preset.theme === "gold-luxury" ? "gold" : "cyan"} className="preset-card">
                      <div className="preset-card-inner">
                        <div className="preset-header">
                          <span className="theme-dot-badge" style={{ backgroundColor: preset.themeColor, boxShadow: `0 0 10px ${preset.themeColor}` }} />
                          <span className="theme-name-tag">{preset.themeName}</span>
                        </div>
                        
                        <h4 className="preset-names">
                          {preset.groom} & {preset.bride}
                        </h4>
                        
                        <p className="preset-date">{preset.date.split("-").reverse().join(" / ")}</p>

                        <div className="qr-image-wrapper">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img 
                            src={qrImgUrl} 
                            alt={`QR Code ${preset.groom} & ${preset.bride}`} 
                            className="qr-img-element"
                          />
                        </div>

                        <div className="preset-actions-panel">
                          <button 
                            className="btn btn-preset-action btn-activate"
                            onClick={() => handleActivatePreset(preset)}
                          >
                            🚀 Aktifkan Acara
                          </button>
                          <a 
                            href={encodedLink} 
                            target="_blank" 
                            rel="noopener noreferrer" 
                            className="btn btn-preset-action btn-preview"
                          >
                            🔗 Buka Link ↗
                          </a>
                          <a 
                            href={qrImgUrl} 
                            target="_blank" 
                            rel="noopener noreferrer" 
                            className="btn btn-preset-action btn-download"
                          >
                            💾 Unduh QR
                          </a>
                        </div>
                      </div>
                    </NeonCard>
                  );
                })}
              </div>
            </div>

            {/* Custom QR Code Generator Form */}
            <NeonCard glowColor="secondary" className="settings-section mt-4">
              <h2 className="section-heading neon-text-secondary">
                <span className="heading-emoji">✉️</span>
                <span>Buat Undangan QR Custom Baru</span>
              </h2>
              <p className="settings-section-desc">
                Ketik nama pasangan lain untuk memvisualisasikan dan menghasilkan QR Code undangan khusus secara instan.
              </p>
              
              <div className="custom-qr-generator-grid">
                <div className="generator-inputs-panel">
                  <div className="form-group">
                    <label className="form-label" htmlFor="customGroomInput">Nama Mempelai Pria</label>
                    <input
                      id="customGroomInput"
                      type="text"
                      placeholder="Contoh: Dani"
                      className="input-field"
                      value={customGroom}
                      onChange={(e) => setCustomGroom(e.target.value)}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="customBrideInput">Nama Mempelai Wanita</label>
                    <input
                      id="customBrideInput"
                      type="text"
                      placeholder="Contoh: Fitri"
                      className="input-field"
                      value={customBride}
                      onChange={(e) => setCustomBride(e.target.value)}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="customDateInput">Tanggal Pernikahan</label>
                    <input
                      id="customDateInput"
                      type="date"
                      className="input-field"
                      value={customDate}
                      onChange={(e) => setCustomDate(e.target.value)}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Tema Warna Neon</label>
                    <div className="custom-theme-selectors">
                      {themesList.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className={`custom-theme-pill ${customTheme === t.id ? "active" : ""}`}
                          onClick={() => setCustomTheme(t.id)}
                          style={{
                            "--pill-color": t.colors[0],
                            border: `1px solid ${customTheme === t.id ? t.colors[0] : "rgba(255,255,255,0.15)"}`
                          } as React.CSSProperties}
                        >
                          {t.name}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="generator-preview-panel glass-panel">
                  {customGroom && customBride ? (
                    <div className="custom-preview-content">
                      <div className="preview-header-meta">PREVIEW KODE QR</div>
                      
                      <h4 className="preview-couple-name">{customGroom} & {customBride}</h4>
                      <p className="preview-wedding-date">{customDate.split("-").reverse().join(" / ")}</p>

                      <div className="qr-image-wrapper glow-border">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img 
                          src={getQrCodeApiUrl(customGroom, customBride, customDate, customTheme)} 
                          alt="Custom QR Preview" 
                          className="qr-img-element"
                        />
                      </div>

                      <div className="generator-preview-actions">
                        <button
                          className="btn btn-primary"
                          onClick={() => {
                            updateEventDetails(customGroom, customBride, customDate);
                            updateTheme(customTheme);
                            alert(`Undangan baru untuk ${customGroom} & ${customBride} diaktifkan global!`);
                          }}
                        >
                          🚀 Aktifkan Sekarang
                        </button>
                        <a
                          href={`${getBaseOrigin()}/?groom=${encodeURIComponent(customGroom)}&bride=${encodeURIComponent(customBride)}&date=${customDate}&theme=${customTheme}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn btn-secondary"
                        >
                          🔗 Uji Link ↗
                        </a>
                      </div>
                    </div>
                  ) : (
                    <div className="generator-preview-placeholder">
                      <span>✉️</span>
                      <p>Ketik nama mempelai untuk mempratinjau QR Code secara real-time.</p>
                    </div>
                  )}
                </div>
              </div>
            </NeonCard>
          </div>
        )}
      </div>

      <style jsx>{`
        .admin-page-container {
          padding: 160px 20px 80px !important;
          display: flex;
          flex-direction: column;
          gap: 30px;
        }

        .admin-header {
          text-align: center;
          margin-top: 20px;
          margin-bottom: 10px;
        }

        .admin-title {
          font-family: var(--font-serif);
          font-size: 2.8rem;
          font-weight: 700;
          margin-bottom: 8px;
        }

        .admin-subtitle {
          font-size: 1.1rem;
          color: var(--text-muted);
          max-width: 600px;
          margin: 0 auto;
        }

        /* Tabs Navigation styling */
        .admin-tabs-nav {
          display: flex;
          justify-content: center;
          gap: 12px;
          padding: 8px;
          border-radius: 40px;
          background: rgba(14, 10, 31, 0.6) !important;
          border: 1px solid rgba(255, 255, 255, 0.05);
          width: fit-content;
          margin: 10px auto 30px;
        }

        .tab-nav-btn {
          padding: 12px 28px;
          border-radius: 30px;
          border: none;
          background: transparent;
          color: var(--text-muted);
          font-weight: 700;
          font-size: 0.95rem;
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
        }

        .tab-nav-btn:hover {
          color: #fff;
          background: rgba(255, 255, 255, 0.04);
        }

        .tab-nav-btn.active {
          color: #fff;
          background: var(--neon-secondary);
          box-shadow: var(--neon-secondary-glow);
          text-shadow: 0 0 5px #fff;
        }

        /* Stats Row */
        .stats-row {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 20px;
          width: 100%;
          margin-bottom: 10px;
        }

        .stat-card-inner {
          padding: 24px 16px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          gap: 10px;
          min-height: 110px;
          width: 100%;
        }

        .stat-value {
          font-size: 1.8rem;
          font-weight: 800;
          line-height: 1.2;
          letter-spacing: 0.5px;
        }

        .stat-label {
          font-size: 0.75rem;
          color: var(--text-muted);
          text-transform: uppercase;
          font-weight: 600;
          letter-spacing: 1px;
        }

        /* Scoped style fixes to target NeonCard properly */
        :global(.settings-section) {
          padding: 30px !important;
          border-radius: 16px !important;
          width: 100% !important;
        }

        :global(.danger-section) {
          border-color: rgba(255, 0, 127, 0.3) !important;
        }

        :global(.mt-4) {
          margin-top: 24px !important;
        }

        .admin-main-content {
          width: 100%;
        }

        .section-heading {
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 1.4rem;
          font-weight: 700;
          margin-bottom: 18px;
        }

        .heading-emoji {
          font-size: 1.5rem;
          flex-shrink: 0;
        }

        .settings-section-desc {
          font-size: 0.95rem;
          color: var(--text-muted);
          margin-bottom: 24px;
          line-height: 1.6;
        }

        .settings-form {
          display: flex;
          flex-direction: column;
          gap: 18px;
        }

        .success-banner {
          background: rgba(57, 255, 20, 0.1);
          border: 1px solid #39ff14;
          color: #39ff14;
          padding: 12px 16px;
          border-radius: 8px;
          font-size: 0.9rem;
          font-weight: 600;
          box-shadow: 0 0 10px rgba(57, 255, 20, 0.1);
        }

        .form-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .form-label {
          font-size: 0.9rem;
          font-weight: 600;
          color: var(--text-muted);
        }

        .save-btn {
          margin-top: 10px;
          height: 48px;
          font-size: 1rem;
        }

        /* 2-Column settings view */
        .settings-tab-grid {
          display: grid;
          grid-template-columns: 1.1fr 1fr;
          gap: 30px;
          align-items: start;
        }

        .flex-col {
          display: flex;
          flex-direction: column;
        }

        .gap-24 {
          gap: 24px;
        }

        /* Theme selection */
        .themes-grid {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .theme-selector-btn {
          display: flex;
          align-items: center;
          gap: 18px;
          padding: 16px 20px;
          border-radius: 12px;
          text-align: left;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          cursor: pointer;
          transition: all 0.3s ease;
          width: 100%;
        }

        .theme-selector-btn:hover {
          background: rgba(255, 255, 255, 0.06);
          border-color: rgba(255, 255, 255, 0.12);
        }

        .theme-selector-btn.active {
          background: rgba(255, 255, 255, 0.08);
          border-color: var(--neon-secondary);
          box-shadow: 0 0 12px rgba(0, 240, 255, 0.2);
        }

        .theme-circles-preview {
          display: flex;
          gap: 6px;
          flex-shrink: 0;
        }

        .theme-circles-preview .circle {
          width: 18px;
          height: 18px;
          border-radius: 50%;
        }

        .theme-meta {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .theme-name {
          font-size: 1rem;
          font-weight: 700;
          color: #fff;
        }

        .theme-desc {
          font-size: 0.78rem;
          color: var(--text-muted);
        }

        /* Danger actions */
        .danger-actions {
          display: flex;
          flex-direction: column;
        }

        .reset-btn {
          color: #ff007f !important;
          border-color: rgba(255, 0, 127, 0.2) !important;
          width: 100%;
          justify-content: center;
          font-size: 0.9rem;
          padding: 12px;
        }

        .reset-btn:hover {
          background: rgba(255, 0, 127, 0.1);
          border-color: #ff007f !important;
          box-shadow: 0 0 10px rgba(255,0,127,0.2);
        }

        /* Tab 1: Moderation Grid */
        .moderation-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 20px;
        }

        .moderation-card-item {
          display: flex;
          flex-direction: column;
          border-radius: 14px;
          overflow: hidden;
          background: rgba(14, 10, 31, 0.45) !important;
          border: 1px solid rgba(255, 255, 255, 0.05);
          transition: all 0.3s ease;
        }

        .moderation-card-item:hover {
          border-color: var(--neon-primary);
          transform: translateY(-2px);
          box-shadow: 0 5px 15px rgba(255, 0, 127, 0.1);
        }

        .moderation-card-thumb {
          width: 100%;
          height: 190px;
          overflow: hidden;
          background: #000;
          position: relative;
        }

        .moderation-card-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .moderation-card-details {
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          flex: 1;
        }

        .moderation-card-meta {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .moderation-card-guest {
          font-weight: 700;
          color: #fff;
          font-size: 1rem;
        }

        .moderation-card-time {
          font-size: 0.78rem;
          color: var(--text-muted);
        }

        .moderation-card-wishes {
          font-size: 0.88rem;
          color: var(--text-muted);
          line-height: 1.5;
          font-style: italic;
          flex: 1;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        .moderation-card-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 6px;
          border-top: 1px solid rgba(255, 255, 255, 0.05);
          padding-top: 12px;
        }

        .filter-badge-pill {
          font-size: 0.78rem;
          color: var(--text-muted);
        }

        .btn-moderation-delete {
          padding: 6px 14px;
          border-radius: 6px;
          border: 1px solid rgba(255, 0, 127, 0.3);
          background: rgba(255, 0, 127, 0.1);
          color: #ff007f;
          font-weight: 700;
          font-size: 0.8rem;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .btn-moderation-delete:hover {
          background: #ff007f;
          color: #fff;
          box-shadow: 0 0 10px rgba(255, 0, 127, 0.4);
        }

        .moderation-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          padding: 80px 20px;
          text-align: center;
          color: var(--text-muted);
        }

        .moderation-empty span {
          font-size: 3rem;
        }

        /* Tab 3: QRs Layout styling */
        .qrs-tab-layout {
          display: flex;
          flex-direction: column;
          gap: 30px;
        }

        .qrs-info-box {
          padding: 20px 24px;
          border-radius: 14px;
          background: rgba(14, 10, 31, 0.5) !important;
          border: 1px solid rgba(0, 240, 255, 0.15);
          box-shadow: inset 0 0 10px rgba(0, 240, 255, 0.05);
        }

        .qrs-info-box h3 {
          color: var(--neon-secondary);
          margin-bottom: 8px;
          font-size: 1.1rem;
        }

        .qrs-info-box p {
          font-size: 0.92rem;
          line-height: 1.6;
        }

        .presets-section {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .sub-section-title {
          font-size: 1.3rem;
          font-weight: 700;
          text-align: left;
          letter-spacing: 0.5px;
        }

        .presets-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 24px;
        }

        :global(.preset-card) {
          border-radius: 20px !important;
          padding: 0 !important;
          overflow: hidden;
        }

        .preset-card-inner {
          padding: 24px;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          width: 100%;
        }

        .preset-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
        }

        .theme-dot-badge {
          width: 10px;
          height: 10px;
          border-radius: 50%;
        }

        .theme-name-tag {
          font-size: 0.78rem;
          font-weight: 700;
          letter-spacing: 1px;
          text-transform: uppercase;
          color: var(--text-muted);
        }

        .preset-names {
          font-size: 1.35rem;
          font-weight: 800;
          margin-bottom: 4px;
          color: #fff;
        }

        .preset-date {
          font-size: 0.85rem;
          color: var(--text-muted);
          font-weight: 600;
          margin-bottom: 16px;
        }

        .qr-image-wrapper {
          width: 170px;
          height: 170px;
          padding: 8px;
          background: #0e0a1f;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 20px;
          box-shadow: 0 4px 15px rgba(0,0,0,0.4);
          transition: all 0.3s ease;
        }

        .qr-image-wrapper.glow-border {
          border-color: var(--neon-secondary);
          box-shadow: 0 0 15px rgba(0, 240, 255, 0.15);
        }

        .qr-img-element {
          width: 100%;
          height: 100%;
          object-fit: contain;
          border-radius: 6px;
        }

        .preset-actions-panel {
          display: flex;
          flex-direction: column;
          gap: 8px;
          width: 100%;
          margin-top: auto;
        }

        .btn-preset-action {
          width: 100%;
          padding: 10px;
          border-radius: 30px;
          font-weight: 700;
          font-size: 0.85rem;
          text-align: center;
          cursor: pointer;
          transition: all 0.2s ease;
          border: none;
        }

        .btn-activate {
          background: #39ff14;
          color: #070412;
          box-shadow: 0 0 10px rgba(57, 255, 20, 0.2);
        }

        .btn-activate:hover {
          background: #50ff30;
          box-shadow: 0 0 15px rgba(57, 255, 20, 0.4);
          transform: scale(1.02);
        }

        .btn-preview {
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255,255,255,0.15);
          color: #fff;
          display: block;
        }

        .btn-preview:hover {
          background: rgba(255, 255, 255, 0.12);
          border-color: rgba(255,255,255,0.3);
        }

        .btn-download {
          background: rgba(0, 240, 255, 0.1);
          border: 1px solid rgba(0, 240, 255, 0.3);
          color: #00f0ff;
          display: block;
        }

        .btn-download:hover {
          background: var(--neon-secondary);
          color: #070412;
          box-shadow: var(--neon-secondary-glow);
        }

        /* Custom generator layout */
        .custom-qr-generator-grid {
          display: grid;
          grid-template-columns: 1.2fr 1fr;
          gap: 30px;
          margin-top: 10px;
        }

        .generator-inputs-panel {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .custom-theme-selectors {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }

        .custom-theme-pill {
          padding: 8px 16px;
          border-radius: 20px;
          background: rgba(255, 255, 255, 0.02);
          color: var(--text-muted);
          font-weight: 700;
          font-size: 0.85rem;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .custom-theme-pill:hover {
          color: #fff;
          background: rgba(255, 255, 255, 0.05);
        }

        .custom-theme-pill.active {
          color: #fff;
          background: rgba(255, 255, 255, 0.05);
          box-shadow: 0 0 10px var(--pill-color);
          text-shadow: 0 0 5px #fff;
        }

        .generator-preview-panel {
          border-radius: 16px;
          padding: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(0,0,0,0.2) !important;
          min-height: 300px;
        }

        .custom-preview-content {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          width: 100%;
        }

        .preview-header-meta {
          font-size: 0.75rem;
          font-weight: 700;
          letter-spacing: 2px;
          color: var(--neon-secondary);
          text-shadow: var(--neon-secondary-glow);
          margin-bottom: 12px;
        }

        .preview-couple-name {
          font-size: 1.4rem;
          font-weight: 800;
          color: #fff;
          margin-bottom: 2px;
        }

        .preview-wedding-date {
          font-size: 0.85rem;
          color: var(--text-muted);
          margin-bottom: 16px;
          font-weight: 600;
        }

        .generator-preview-actions {
          display: flex;
          gap: 12px;
          width: 100%;
        }

        .generator-preview-actions .btn {
          flex: 1;
          height: 40px;
          font-size: 0.85rem;
        }

        .generator-preview-placeholder {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          gap: 12px;
          color: var(--text-muted);
        }

        .generator-preview-placeholder span {
          font-size: 2.8rem;
        }

        .generator-preview-placeholder p {
          font-size: 0.9rem;
          max-width: 240px;
        }

        /* Responsive Layouts */
        @media (max-width: 992px) {
          .settings-tab-grid,
          .custom-qr-generator-grid {
            grid-template-columns: 1fr;
            gap: 24px;
          }
          .presets-grid {
            grid-template-columns: 1fr;
            gap: 20px;
          }
          .stats-row {
            grid-template-columns: 1fr;
            gap: 12px;
          }
        }

        @media (max-width: 768px) {
          .admin-page-container {
            padding: 110px 16px 60px !important;
          }
          .admin-header {
            margin-top: 10px !important;
          }
          .admin-title {
            font-size: 2.2rem;
          }
          .admin-tabs-nav {
            flex-direction: column;
            border-radius: 20px;
            width: 100%;
            padding: 6px;
          }
          .tab-nav-btn {
            width: 100%;
            padding: 10px 20px;
          }
          .qr-image-wrapper {
            width: 150px;
            height: 150px;
          }
        }
      `}</style>
    </div>
  );
}
