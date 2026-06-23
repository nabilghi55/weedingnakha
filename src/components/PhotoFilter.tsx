"use client";

import React from "react";

export interface FilterOption {
  id: string;
  name: string;
  className: string;
  color: string;
}

export const FILTER_OPTIONS: FilterOption[] = [
  { id: "none", name: "Original", className: "", color: "transparent" },
  { id: "neon-pink", name: "Cyber Pink", className: "filter-neon-pink", color: "#ff007f" },
  { id: "neon-cyan", name: "Future Cyan", className: "filter-neon-cyan", color: "#00f0ff" },
  { id: "neon-gold", name: "Golden Hour", className: "filter-neon-gold", color: "#ffb800" },
  { id: "neon-green", name: "Acid Green", className: "filter-neon-green", color: "#39ff14" },
];

interface PhotoFilterProps {
  imageSrc: string;
  selectedFilter: string;
  onChangeFilter: (filterId: string) => void;
}

export default function PhotoFilter({
  imageSrc,
  selectedFilter,
  onChangeFilter,
}: PhotoFilterProps) {
  return (
    <div className="photo-filter-container">
      <div className="preview-box-wrapper">
        <div className={`preview-box filter-preview-${selectedFilter}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageSrc} alt="Preview" className="preview-image" />
          <div className="filter-overlay" />
        </div>
      </div>

      <div className="filter-options-grid">
        {FILTER_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`filter-option-btn ${selectedFilter === option.id ? "active" : ""}`}
            onClick={() => onChangeFilter(option.id)}
            style={{ "--accent-color": option.color } as React.CSSProperties}
          >
            <div className="option-preview-wrapper">
              <div className={`option-preview-img-box filter-preview-${option.id}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageSrc} alt={option.name} className="option-preview-img" />
                <div className="filter-overlay" />
              </div>
            </div>
            <span className="option-name">{option.name}</span>
          </button>
        ))}
      </div>

      <style jsx>{`
        .photo-filter-container {
          display: flex;
          flex-direction: column;
          gap: 20px;
          width: 100%;
        }

        .preview-box-wrapper {
          width: 100%;
          aspect-ratio: 1;
          border-radius: 12px;
          overflow: hidden;
          background: #000;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .preview-box {
          position: relative;
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .preview-image {
          width: 100%;
          height: 100%;
          object-fit: cover;
          transition: all 0.3s ease;
        }

        .filter-overlay {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          transition: all 0.3s ease;
          mix-blend-mode: color;
          opacity: 0;
        }

        /* Filter Preview Rules */
        .filter-preview-none .preview-image {
          filter: brightness(1) contrast(1) saturate(1);
        }

        .filter-preview-neon-pink .preview-image {
          filter: brightness(0.9) contrast(1.2) saturate(1.4);
        }
        .filter-preview-neon-pink .filter-overlay {
          background-color: #ff007f;
          opacity: 0.55;
          mix-blend-mode: color;
        }

        .filter-preview-neon-cyan .preview-image {
          filter: brightness(0.9) contrast(1.25) saturate(1.3);
        }
        .filter-preview-neon-cyan .filter-overlay {
          background-color: #00f0ff;
          opacity: 0.55;
          mix-blend-mode: color;
        }

        .filter-preview-neon-gold .preview-image {
          filter: brightness(0.9) contrast(1.1) saturate(1.4);
        }
        .filter-preview-neon-gold .filter-overlay {
          background-color: #ffb800;
          opacity: 0.45;
          mix-blend-mode: overlay;
        }

        .filter-preview-neon-green .preview-image {
          filter: brightness(0.85) contrast(1.3) saturate(1.5);
        }
        .filter-preview-neon-green .filter-overlay {
          background-color: #39ff14;
          opacity: 0.5;
          mix-blend-mode: color;
        }

        .filter-options-grid {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 8px;
          width: 100%;
        }

        .filter-option-btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          background: transparent;
          border: none;
          cursor: pointer;
          padding: 4px;
          border-radius: 8px;
          transition: all 0.2s ease;
        }

        .filter-option-btn:hover {
          background: rgba(255, 255, 255, 0.04);
        }

        .filter-option-btn.active {
          background: rgba(255, 255, 255, 0.08);
        }

        .option-preview-wrapper {
          width: 100%;
          aspect-ratio: 1;
          border-radius: 8px;
          overflow: hidden;
          border: 2px solid transparent;
          transition: all 0.2s ease;
        }

        .filter-option-btn.active .option-preview-wrapper {
          border-color: var(--accent-color, var(--neon-primary));
          box-shadow: 0 0 8px var(--accent-color, var(--neon-primary));
        }

        .option-preview-img-box {
          position: relative;
          width: 100%;
          height: 100%;
        }

        .option-preview-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .option-name {
          font-size: 0.75rem;
          color: var(--text-muted);
          font-weight: 500;
          text-align: center;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          width: 100%;
        }

        .filter-option-btn.active .option-name {
          color: #fff;
          font-weight: 600;
        }

        @media (max-width: 480px) {
          .filter-options-grid {
            gap: 4px;
          }
          .option-name {
            font-size: 0.7rem;
          }
        }
      `}</style>
    </div>
  );
}
