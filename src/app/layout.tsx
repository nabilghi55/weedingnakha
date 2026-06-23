import type { Metadata } from "next";
import { Lexend } from "next/font/google";
import "./globals.css";
import { AppProvider } from "@/context/AppContext";
import Navbar from "@/components/Navbar";

const lexend = Lexend({
  subsets: ["latin"],
  variable: "--font-lexend",
  weight: ["300", "400", "500", "600", "700", "800", "900"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Nakha Wedding | Live Guest Gallery & Book",
  description: "Capture beautiful glowing moments together. Upload photos, apply neon filters, and leave wedding wishes instantly.",
  keywords: "wedding, digital guestbook, neon photos, photo sharing, live slideshow",
  authors: [{ name: "Antigravity Team" }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id" className={lexend.variable}>
      <body>
        <AppProvider>
          <Navbar />
          <main className="app-main">
            {children}
          </main>
        </AppProvider>
      </body>
    </html>
  );
}
