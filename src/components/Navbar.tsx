"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApp } from "@/context/AppContext";
import { useState } from "react";

export default function Navbar() {
  const pathname = usePathname();
  const { groomName, brideName } = useApp();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navLinks = [
    { href: "/", label: "Beranda" },
    { href: "/gallery", label: "Galeri Foto" },
    { href: "/photobooth", label: "Photobooth" },
    { href: "/upload", label: "Kirim Foto" },
    { href: "/slideshow", label: "Slideshow" },
    { href: "/admin", label: "Admin" },
  ];

  return (
    <nav className="navbar-container">
      <div className="navbar-inner glass-panel">
        <Link href="/" className="navbar-logo">
          <span className="logo-groom">Nakha</span>
          <span className="logo-bride" style={{ marginLeft: "4px" }}>Wedding</span>
        </Link>

        {/* Desktop Menu */}
        <div className="navbar-links">
          {navLinks.map((link) => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`nav-link ${isActive ? "active" : ""}`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>

        {/* Mobile Toggle Button */}
        <button
          className="mobile-toggle"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label="Toggle navigation menu"
        >
          <div className={`bar ${mobileMenuOpen ? "close-1" : ""}`}></div>
          <div className={`bar ${mobileMenuOpen ? "close-2" : ""}`} style={{ opacity: mobileMenuOpen ? 0 : 1 }}></div>
          <div className={`bar ${mobileMenuOpen ? "close-3" : ""}`}></div>
        </button>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="mobile-menu glass-panel neon-border-primary">
          {navLinks.map((link) => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`mobile-nav-link ${isActive ? "active" : ""}`}
                onClick={() => setMobileMenuOpen(false)}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      )}

      <style jsx>{`
        .navbar-container {
          position: fixed;
          top: 20px;
          left: 0;
          right: 0;
          z-index: 100;
          padding: 0 20px;
          width: 100%;
          max-width: 1200px;
          margin: 0 auto;
        }

        .navbar-inner {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 24px;
          border-radius: 50px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(14, 10, 31, 0.75);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }

        .navbar-logo {
          display: flex;
          align-items: center;
          gap: 6px;
          font-family: var(--font-serif);
          font-size: 1.35rem;
          font-weight: 700;
          color: #fff;
          text-decoration: none;
          text-shadow: 0 0 10px rgba(255, 255, 255, 0.2);
          white-space: nowrap;
        }

        .logo-groom {
          color: #fff;
          text-shadow: var(--neon-primary-glow);
        }

        .logo-ampersand {
          color: var(--text-muted);
          font-size: 1rem;
          font-style: italic;
        }

        .logo-bride {
          color: #fff;
          text-shadow: var(--neon-secondary-glow);
        }

        .navbar-links {
          display: flex;
          gap: 16px;
          align-items: center;
        }

        .nav-link {
          padding: 8px 16px;
          font-size: 0.88rem;
          font-weight: 600;
          color: #a9a4b8;
          border-radius: 20px;
          transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
          position: relative;
          white-space: nowrap;
          border: 1px solid transparent;
        }

        .nav-link::after {
          content: '';
          position: absolute;
          bottom: 2px;
          left: 50%;
          width: 0;
          height: 2px;
          background: var(--neon-primary);
          box-shadow: var(--neon-primary-glow);
          transition: all 0.3s ease;
          transform: translateX(-50%);
        }

        .nav-link:hover {
          color: #fff;
          text-shadow: 0 0 10px rgba(255, 255, 255, 0.4);
        }

        .nav-link:hover::after {
          width: 60%;
        }

        .nav-link.active {
          color: #fff;
          background: rgba(255, 255, 255, 0.06);
          border-color: rgba(255, 255, 255, 0.12);
          box-shadow: 0 0 12px rgba(255, 255, 255, 0.03);
          text-shadow: 0 0 10px rgba(255, 255, 255, 0.4);
        }

        .nav-link.active::after {
          width: 70%;
          background: var(--neon-secondary);
          box-shadow: var(--neon-secondary-glow);
        }

        .mobile-toggle {
          display: none;
          flex-direction: column;
          justify-content: space-between;
          width: 24px;
          height: 16px;
          background: transparent;
          border: none;
          cursor: pointer;
          padding: 0;
          z-index: 101;
        }

        .bar {
          width: 100%;
          height: 2px;
          background-color: #fff;
          transition: all 0.3s ease;
        }

        .close-1 {
          transform: translateY(7px) rotate(45deg);
        }

        .close-2 {
          opacity: 0;
        }

        .close-3 {
          transform: translateY(-7px) rotate(-45deg);
        }

        .mobile-menu {
          display: none;
          position: absolute;
          top: 70px;
          left: 20px;
          right: 20px;
          flex-direction: column;
          gap: 8px;
          padding: 20px;
          border-radius: 20px;
        }

        .mobile-nav-link {
          padding: 10px 16px;
          border-radius: 10px;
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--text-muted);
          transition: all 0.3s ease;
        }

        .mobile-nav-link:hover, .mobile-nav-link.active {
          color: #fff;
          background: rgba(255, 255, 255, 0.06);
          text-shadow: 0 0 8px rgba(255, 255, 255, 0.3);
        }

        @media (max-width: 992px) {
          .navbar-links {
            display: none;
          }

          .mobile-toggle {
            display: flex;
          }

          .mobile-menu {
            display: flex;
          }
        }
      `}</style>
    </nav>
  );
}
