import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Dancing_Script, Italiana, Playfair_Display, Plus_Jakarta_Sans, Source_Serif_4 } from "next/font/google";
import "./globals.css";
import { AppProvider } from "@/context/AppContext";
import AppShell from "@/components/AppShell";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
  weight: ["400", "500", "600", "700", "800", "900"],
  style: ["normal", "italic"],
  display: "swap",
});

// Kept for photo frames / QR cards drawn on canvas (they read --font-playfair & --font-news)
const news = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-news",
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
  display: "swap",
});

// Display face: hairline high-contrast capitals (free stand-in for Monteilga / Tomolens / Monrovia)
const display = Italiana({
  subsets: ["latin"],
  variable: "--font-display",
  weight: "400",
  display: "swap",
});

// Elegant readable serif for sub-headings & italic accents
const elegant = Cormorant_Garamond({
  subsets: ["latin"],
  variable: "--font-elegant",
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  display: "swap",
});

// Handwritten caption on moment polaroids (canvas only, reads --font-script)
const script = Dancing_Script({
  subsets: ["latin"],
  variable: "--font-script",
  weight: ["500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Seribu Lensa — Wedding Photobooth",
  description:
    "Photobooth digital oleh Seribu Lensa (@seribu.lensa) untuk pernikahan, acara kampus, dan acara perusahaan: foto tamu tampil live di galeri dan layar acara.",
};

export const viewport: Viewport = {
  themeColor: "#fbebd9",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" data-theme="maroon" className={`${jakarta.variable} ${playfair.variable} ${news.variable} ${display.variable} ${elegant.variable} ${script.variable}`}>
      <body>
        <AppProvider>
          <AppShell>{children}</AppShell>
        </AppProvider>
      </body>
    </html>
  );
}
