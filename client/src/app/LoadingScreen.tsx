import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader } from '../ui/logo/Logo';

/** The loading screen shows for at least this long (so the logo animation is seen); no extra wait if loading takes longer. */
export const ENTRY_MIN_MS = 1400;

/**
 * Loading screen when a screen opens: true until the content is ready AND at least `minMs` has passed.
 * Starts again on every opening (back to the shelf, every book).
 */
export function useEntryLoader(ready: boolean, minMs = ENTRY_MIN_MS) {
  const [start] = useState(() => performance.now());
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!ready || done) return;
    const t = window.setTimeout(() => setDone(true), Math.max(0, minMs - (performance.now() - start)));
    return () => window.clearTimeout(t);
  }, [ready, done, minMs, start]);
  // If something gets stuck, do not hold the screen forever
  useEffect(() => {
    const t = window.setTimeout(() => setDone(true), 15_000);
    return () => window.clearTimeout(t);
  }, []);
  return !done;
}

/** Like the start-up screen: full-screen paper with the logo animation in the middle; fades out when done. */
export function LoadingScreen({ show }: { show: boolean }) {
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) {
      setMounted(true);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), 450);
    return () => window.clearTimeout(t);
  }, [show]);
  if (!mounted) return null;
  return createPortal(
    <div className={`st-loading${show ? '' : ' done'}`} role="status" aria-label="Loading">
      <Loader label="Hyperfocus" />
    </div>,
    document.body,
  );
}
