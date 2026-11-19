"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Camera, Images } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { eventDateTime, eventName } from "@/lib/format";
import { BRAND } from "@/lib/brand";
import styles from "./Navbar.module.css";

const LINKS = [
  { href: "/photobooth", label: "Photobooth Digital", short: "Photobooth", icon: Camera },
  { href: "/gallery", label: "Galeri", short: "Galeri", icon: Images },
  // Live Wall is not in the menu: it opens only from the host's display link (projector)
];

/** Boutique header: event names · centered studio logo · menu. */
export default function Navbar() {
  const pathname = usePathname();
  const { event } = useApp();
  const isActive = (href: string) => pathname.startsWith(href);
  const names = eventName(event);
  const date = eventDateTime(event).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });

  return (
    <>
      <header className={styles.header}>
        <div className={styles.inner}>
          <div className={styles.eventInfo}>
            <span className={styles.names}>{names}</span>
            <span className={styles.date}>{date}</span>
          </div>

          <Link href="/photobooth" className={styles.brand} aria-label={`${BRAND.name} — Photobooth`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={BRAND.logo} alt="" className={styles.logo} width={512} height={341} />
            <span className={styles.wordmark}>{BRAND.name}</span>
            <span className={styles.mobileLine}>
              <span aria-hidden="true">✦</span> {names} <span aria-hidden="true">✦</span>
            </span>
          </Link>

          <nav className={styles.links} aria-label="Navigasi utama">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className={`${styles.link} ${isActive(l.href) ? styles.active : ""}`}>
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <nav className={styles.tabbar} aria-label="Navigasi">
        {LINKS.map((l) => {
          const Icon = l.icon;
          return (
            <Link key={l.href} href={l.href} className={`${styles.tab} ${isActive(l.href) ? styles.tabActive : ""}`}>
              <Icon />
              <span>{l.short}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
