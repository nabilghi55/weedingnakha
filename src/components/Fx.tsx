"use client";

/**
 * Motion layer (adapted from the GoSinema site): scroll reveals, split-text
 * headings, a scroll-lit statement, marquee and parallax.
 * Everything respects prefers-reduced-motion.
 */
import { Fragment, createElement, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { usePathname } from "next/navigation";

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Adds `.is-in` to every [data-reveal] element as it scrolls into view. */
export function RevealObserver() {
  const pathname = usePathname();
  useEffect(() => {
    const root = document.body;
    if (reducedMotion() || !("IntersectionObserver" in window)) {
      root.querySelectorAll("[data-reveal]").forEach((el) => el.classList.add("is-in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.1 },
    );
    const scan = () => root.querySelectorAll("[data-reveal]:not(.is-in)").forEach((el) => io.observe(el));
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [pathname]);
  return null;
}

type SplitProps = {
  text: string;
  as?: "h1" | "h2" | "h3" | "p" | "span";
  className?: string;
  delay?: number;
};

/** Each word rises out of a mask, staggered. Use "\n" for line breaks. */
export function SplitText({ text, as = "h2", className = "", delay = 0 }: SplitProps) {
  let i = 0;
  return createElement(
    as,
    { className: `split-text ${className}`, "data-reveal": "", "aria-label": text.replace(/\n/g, " ") },
    text.split("\n").map((line, li) => (
      <span className="split-text__line" key={li} aria-hidden="true">
        {line.split(" ").map((word, wi) => (
          <Fragment key={wi}>
            {wi > 0 && " "}
            <span className="split-text__mask">
              <span className="split-text__word" style={{ "--d": `${delay + i++ * 70}ms` } as CSSProperties}>
                {word}
              </span>
            </span>
          </Fragment>
        ))}
      </span>
    )),
  );
}

export function Marquee({ items, variant = "accent" }: { items: string[]; variant?: "accent" | "dark" | "outline" }) {
  const row = (hidden: boolean) => (
    <div className="marquee__row" aria-hidden={hidden || undefined}>
      {items.map((t, i) => (
        <span key={i} className="marquee__item">
          {t}
          <span className="marquee__star">✦</span>
        </span>
      ))}
    </div>
  );
  return (
    <div className={`marquee marquee--${variant}`} role="presentation">
      <div className="marquee__track">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}

/** Big statement whose words darken as the reader scrolls through it. */
export function ScrollWords({ text, className = "" }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const spans = Array.from(el.querySelectorAll<HTMLSpanElement>(".scroll-words__w"));
    if (reducedMotion()) {
      spans.forEach((s) => s.classList.add("is-lit"));
      return;
    }
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const start = vh * 0.85;
      const end = vh * 0.45;
      const progress = Math.min(1, Math.max(0, (start - r.top) / (r.height + start - end)));
      const lit = Math.round(progress * spans.length);
      spans.forEach((s, i) => s.classList.toggle("is-lit", i < lit));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [text]);

  return (
    <p ref={ref} className={`scroll-words ${className}`}>
      {text.split(" ").map((w, i) => (
        <span key={i} className="scroll-words__w">
          {w}{" "}
        </span>
      ))}
    </p>
  );
}

/** Sets --py (px) and --pp (0…1) on the element as the page scrolls. */
export function useParallax<T extends HTMLElement>(speed = 0.25) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    // Scroll-linked transforms jitter with touch momentum scrolling, so desktop only.
    if (!el || reducedMotion() || !window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 861px)").matches) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const y = Math.min(window.scrollY, window.innerHeight * 1.2);
      el.style.setProperty("--py", `${y * speed}px`);
      el.style.setProperty("--pp", `${Math.min(1, y / window.innerHeight)}`);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [speed]);
  return ref;
}

/** <Reveal> adds data-reveal with a stagger index. */
export function Reveal({
  children,
  i = 0,
  className = "",
  as = "div",
}: {
  children: ReactNode;
  i?: number;
  className?: string;
  as?: "div" | "li" | "article" | "section";
}) {
  return createElement(as, { className, "data-reveal": "", style: { "--i": i } as CSSProperties }, children);
}
