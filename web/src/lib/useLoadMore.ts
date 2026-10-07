import { useEffect, useRef } from "react";

// Calls `load` whenever the returned sentinel element scrolls into view and
// there is more to load. Put the sentinel at the end of a list.
export function useLoadMore(hasMore: boolean, loading: boolean, load: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loading) load();
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, load]);
  return ref;
}
