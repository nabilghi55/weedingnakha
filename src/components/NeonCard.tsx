"use client";

import React from "react";

interface NeonCardProps {
  children: React.ReactNode;
  glowColor?: "primary" | "secondary" | "pink" | "cyan" | "gold" | "green";
  animate?: "none" | "float" | "pulse";
  className?: string;
}

export default function NeonCard({
  children,
  glowColor = "primary",
  animate = "none",
  className = "",
}: NeonCardProps) {
  const getGlowStyle = () => {
    switch (glowColor) {
      case "secondary":
        return "var(--neon-secondary-glow)";
      case "pink":
        return "0 0 10px #ff007f, 0 0 20px #ff007f";
      case "cyan":
        return "0 0 10px #00f0ff, 0 0 20px #00f0ff";
      case "gold":
        return "0 0 10px #ffb800, 0 0 20px #ffb800";
      case "green":
        return "0 0 10px #39ff14, 0 0 20px #39ff14";
      case "primary":
      default:
        return "var(--neon-primary-glow)";
    }
  };

  const getBorderColor = () => {
    switch (glowColor) {
      case "secondary":
        return "var(--neon-secondary)";
      case "pink":
        return "#ff007f";
      case "cyan":
        return "#00f0ff";
      case "gold":
        return "#ffb800";
      case "green":
        return "#39ff14";
      case "primary":
      default:
        return "var(--neon-primary)";
    }
  };

  const getAnimationClass = () => {
    if (animate === "float") return "neon-float";
    if (animate === "pulse") return "neon-pulse-card";
    return "";
  };

  return (
    <div
      className={`neon-card glass-panel ${getAnimationClass()} ${className}`}
      style={{
        "--card-glow": getGlowStyle(),
        "--card-border-color": getBorderColor(),
      } as React.CSSProperties}
    >
      {children}

      <style jsx global>{`
        .neon-card {
          border: 1px solid var(--card-border-color);
          box-shadow: 0 0 10px rgba(255, 255, 255, 0.02), var(--card-glow);
          transition: all 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
        }

        .neon-card:hover {
          box-shadow: 0 0 15px var(--card-border-color), var(--card-glow), inset 0 0 10px rgba(255, 255, 255, 0.05);
          transform: translateY(-4px);
        }

        @keyframes pulse-card-glow {
          0%, 100% {
            box-shadow: 0 0 8px rgba(255, 255, 255, 0.02), var(--card-glow);
          }
          50% {
            box-shadow: 0 0 15px var(--card-border-color), var(--card-glow), inset 0 0 12px rgba(255, 255, 255, 0.08);
          }
        }

        .neon-pulse-card {
          animation: pulse-card-glow 3s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
