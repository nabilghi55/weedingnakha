"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * No invitation page: the site is the photobooth. "/" forwards to /photobooth
 * and keeps the query string (?e=slug, ?qr=…) so event links keep working.
 */
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.replace(`/photobooth${window.location.search}`);
  }, [router]);

  return (
    <div className="page">
      <div className="container" style={{ display: "grid", placeItems: "center", minHeight: "50vh" }}>
        <span className="spinner" />
      </div>
    </div>
  );
}
