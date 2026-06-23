"use client";

import { useApp } from "@/context/AppContext";
import NeonCard from "@/components/NeonCard";
import PhotoFilter from "@/components/PhotoFilter";
import Link from "next/link";
import { useState, useRef } from "react";

export default function UploadPage() {
  const { addPhoto, groomName, brideName } = useApp();
  const [guestName, setGuestName] = useState("");
  const [wishes, setWishes] = useState("");
  const [selectedFilter, setSelectedFilter] = useState("none");
  
  // Image states
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Read file and set initial preview
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setErrorMessage("Silakan pilih file gambar saja.");
      return;
    }

    setErrorMessage("");
    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) {
        setImageSrc(event.target.result as string);
      }
    };
    reader.readAsDataURL(file);
  };

  // Trigger file click
  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  // Compress image client-side to save localStorage space
  const compressImage = (base64Str: string): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.src = base64Str;
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        
        // Define max size
        const MAX_WIDTH = 600;
        const MAX_HEIGHT = 600;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;

        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          // Compress to JPEG with 0.6 quality
          const compressedDataUrl = canvas.toDataURL("image/jpeg", 0.65);
          resolve(compressedDataUrl);
        } else {
          resolve(base64Str);
        }
      };
      img.onerror = () => {
        resolve(base64Str);
      };
    });
  };

  // Submit Handler
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!guestName.trim()) {
      setErrorMessage("Nama tidak boleh kosong.");
      return;
    }
    if (!imageSrc) {
      setErrorMessage("Silakan pilih atau ambil foto Anda terlebih dahulu.");
      return;
    }

    try {
      setIsCompressing(true);
      setErrorMessage("");

      // Compress image
      const compressedImage = await compressImage(imageSrc);

      // Add to global state
      addPhoto(guestName, wishes, compressedImage, selectedFilter);

      setIsCompressing(false);
      setIsSubmitted(true);
    } catch (err) {
      console.error(err);
      setIsCompressing(false);
      setErrorMessage("Terjadi kesalahan saat memproses foto. Coba lagi.");
    }
  };

  const handleResetForm = () => {
    setGuestName("");
    setWishes("");
    setImageSrc(null);
    setSelectedFilter("none");
    setIsSubmitted(false);
    setErrorMessage("");
  };

  return (
    <div className="upload-page-container container">
      {/* Background Glows */}
      <div className="neon-orb-1" />

      {!isSubmitted ? (
        <div className="upload-form-wrapper">
          <header className="upload-header">
            <h1 className="upload-title">
              Kirim <span className="neon-text-secondary">Kenangan</span> Anda
            </h1>
            <p className="upload-subtitle">
              Bagikan momen keseruan Anda di pesta pernikahan{" "}
              <span className="couple-highlight">{groomName} & {brideName}</span>
            </p>
          </header>

          <NeonCard glowColor="primary" className="form-card">
            <form onSubmit={handleSubmit} className="upload-form">
              {errorMessage && (
                <div className="error-alert glass-panel">
                  <span>⚠️</span> {errorMessage}
                </div>
              )}

              {/* Form Input fields */}
              <div className="form-group">
                <label className="form-label" htmlFor="guestName">
                  Nama Anda <span className="required">*</span>
                </label>
                <input
                  id="guestName"
                  type="text"
                  className="input-field"
                  placeholder="Contoh: Andi, Rina & Keluarga"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  disabled={isCompressing}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="wishes">
                  Ucapan & Doa Restu
                </label>
                <textarea
                  id="wishes"
                  className="input-field textarea-field"
                  placeholder="Tuliskan ucapan selamat dan doa terbaik Anda..."
                  value={wishes}
                  onChange={(e) => setWishes(e.target.value)}
                  disabled={isCompressing}
                  rows={3}
                />
              </div>

              {/* Image upload preview & selector */}
              <div className="form-group">
                <label className="form-label">
                  Pilih / Ambil Foto <span className="required">*</span>
                </label>

                {!imageSrc ? (
                  <button
                    type="button"
                    className="upload-dropzone glass-panel"
                    onClick={triggerFileSelect}
                  >
                    <div className="dropzone-icon">📸</div>
                    <h3>Ambil Foto / Upload</h3>
                    <p>Klik untuk membuka Kamera atau Galeri ponsel Anda</p>
                  </button>
                ) : (
                  <div className="filter-preview-wrapper">
                    <PhotoFilter
                      imageSrc={imageSrc}
                      selectedFilter={selectedFilter}
                      onChangeFilter={setSelectedFilter}
                    />
                    <button
                      type="button"
                      className="btn btn-flat change-photo-btn"
                      onClick={triggerFileSelect}
                      disabled={isCompressing}
                    >
                      🔄 Ganti Foto
                    </button>
                  </div>
                )}

                {/* Hidden File Input */}
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="image/*"
                  capture="environment" // open back camera directly on mobile devices
                  style={{ display: "none" }}
                />
              </div>

              {/* Action Submit */}
              <button
                type="submit"
                className="btn btn-primary submit-btn"
                disabled={isCompressing || !imageSrc || !guestName.trim()}
              >
                {isCompressing ? (
                  <>
                    <span className="spinner" /> Memproses Foto...
                  </>
                ) : (
                  "✨ Kirim Foto & Ucapan"
                )}
              </button>
            </form>
          </NeonCard>
        </div>
      ) : (
        /* Success Screen */
        <div className="success-wrapper">
          <NeonCard glowColor="secondary" className="success-card neon-float">
            <div className="success-content">
              <div className="success-badge">✨</div>
              <h2 className="neon-text-secondary">Foto Berhasil Dikirim!</h2>
              <p>
                Terima kasih, <strong>{guestName}</strong>! Foto dan ucapan hangat Anda telah masuk ke galeri dan akan segera ditayangkan di layar panggung.
              </p>

              {/* Submitted Card Preview */}
              <div className="submitted-preview glass-panel">
                <div className={`preview-img-container photo-container-filtered filter-${selectedFilter}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageSrc || ""} alt="Submitted preview" className="preview-img" />
                </div>
                <div className="preview-text">
                  <h4 className="preview-name">{guestName}</h4>
                  <p className="preview-wishes">"{wishes || "Selamat menempuh hidup baru!"}"</p>
                </div>
              </div>

              <div className="success-actions">
                <Link href="/gallery" className="btn btn-primary">
                  🖼️ Lihat Galeri Live
                </Link>
                <button onClick={handleResetForm} className="btn btn-secondary">
                  📸 Kirim Foto Lagi
                </button>
              </div>
            </div>
          </NeonCard>
        </div>
      )}

      <style jsx>{`
        .upload-page-container {
          padding: 140px 20px 80px !important;
          display: flex;
          justify-content: center;
          align-items: center;
          position: relative;
        }

        .neon-orb-1 {
          position: absolute;
          width: 300px;
          height: 300px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(0, 240, 255, 0.12) 0%, rgba(0, 0, 0, 0) 70%);
          top: 20%;
          left: 50%;
          transform: translate(-50%, -50%);
          z-index: -1;
          filter: blur(40px);
        }

        .upload-form-wrapper, .success-wrapper {
          width: 100%;
          max-width: 520px;
          display: flex;
          flex-direction: column;
          gap: 30px;
        }

        .upload-header {
          text-align: center;
          margin-top: 60px;
        }

        .upload-title {
          font-family: var(--font-serif);
          font-size: 2.6rem;
          font-weight: 700;
          margin-bottom: 8px;
        }

        .upload-subtitle {
          font-size: 1rem;
          color: var(--text-muted);
        }

        .couple-highlight {
          color: #fff;
          font-weight: 600;
        }

        .form-card {
          width: 100%;
          border-radius: 16px;
        }

        .upload-form {
          padding: 30px;
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .error-alert {
          padding: 12px 16px;
          border-radius: 8px;
          border-color: rgba(255, 60, 0, 0.3) !important;
          background: rgba(255, 60, 0, 0.1) !important;
          color: #ff3c00;
          font-size: 0.9rem;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .form-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .form-label {
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--text-light);
        }

        .required {
          color: var(--neon-primary);
        }

        .textarea-field {
          resize: none;
        }

        /* Dropzone */
        .upload-dropzone {
          width: 100%;
          padding: 40px 20px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          border-style: dashed !important;
          border-color: rgba(255, 255, 255, 0.15) !important;
          border-radius: 12px;
          cursor: pointer;
          transition: all 0.3s ease;
          text-align: center;
        }

        .upload-dropzone:hover {
          border-color: var(--neon-secondary) !important;
          box-shadow: 0 0 10px rgba(0, 240, 255, 0.15);
          background: rgba(0, 240, 255, 0.02) !important;
        }

        .dropzone-icon {
          font-size: 2.8rem;
          animation: float 4s ease-in-out infinite;
        }

        .upload-dropzone h3 {
          font-size: 1.15rem;
          font-weight: 700;
          color: #fff;
        }

        .upload-dropzone p {
          font-size: 0.85rem;
          color: var(--text-muted);
        }

        .filter-preview-wrapper {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
          width: 100%;
        }

        .change-photo-btn {
          width: 100%;
          max-width: 200px;
          padding: 8px 16px;
          font-size: 0.85rem;
        }

        .submit-btn {
          margin-top: 10px;
          width: 100%;
          height: 48px;
          font-size: 1rem;
        }

        /* Success Screen CSS */
        .success-card {
          border-radius: 20px;
          width: 100%;
        }

        .success-content {
          padding: 40px 30px;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          gap: 20px;
        }

        .success-badge {
          width: 70px;
          height: 70px;
          border-radius: 50%;
          background: rgba(0, 240, 255, 0.1);
          color: #00f0ff;
          border: 1.5px solid #00f0ff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 2rem;
          box-shadow: 0 0 15px rgba(0, 240, 255, 0.3);
        }

        .success-content p {
          color: var(--text-muted);
          font-size: 0.95rem;
          line-height: 1.6;
        }

        .success-content strong {
          color: #fff;
        }

        .submitted-preview {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 16px;
          border-radius: 12px;
          background: rgba(0, 0, 0, 0.3) !important;
          text-align: left;
        }

        .preview-img-container {
          width: 70px;
          height: 70px;
          border-radius: 8px;
          overflow: hidden;
          flex-shrink: 0;
          background: #000;
        }

        .preview-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .preview-text {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0; /* allows overflow truncation to work */
        }

        .preview-name {
          font-size: 0.9rem;
          font-weight: 700;
          color: #fff;
        }

        .preview-wishes {
          font-size: 0.8rem;
          color: var(--text-muted);
          font-style: italic;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .success-actions {
          display: flex;
          width: 100%;
          gap: 12px;
          margin-top: 10px;
        }

        .success-actions .btn {
          flex: 1;
        }

        /* Spinner for submit loading state */
        .spinner {
          display: inline-block;
          width: 16px;
          height: 16px;
          border: 2px solid rgba(255, 255, 255, 0.3);
          border-radius: 50%;
          border-top-color: #fff;
          animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }

        @media (max-width: 768px) {
          .upload-page-container {
            padding: 100px 16px 60px !important;
          }
          .upload-header {
            margin-top: 20px !important;
          }
          .upload-title {
            font-size: 2.2rem;
          }
          .upload-form {
            padding: 20px;
          }
          .success-content {
            padding: 30px 20px;
          }
          .success-actions {
            flex-direction: column;
          }
        }
      `}</style>
    </div>
  );
}
