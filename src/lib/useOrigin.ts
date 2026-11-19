"use client";

import { useSyncExternalStore } from "react";

const noop = () => () => {};

/** window.location.origin on the client, "" during SSR. */
export function useOrigin() {
  return useSyncExternalStore(
    noop,
    () => window.location.origin,
    () => "",
  );
}

/** Reads a query param on the client without needing a Suspense boundary. */
export function useQueryParam(key: string) {
  return useSyncExternalStore(
    noop,
    () => new URLSearchParams(window.location.search).get(key),
    () => null,
  );
}
