import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const KEY = 'hyperfocus-sepia';

const read = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * Eye comfort: tints the whole screen sepia and muted (lower brightness and contrast).
 * The button sits at the bottom left on every screen; the choice is remembered in the browser.
 */
export function EyeComfort() {
  const [on, setOn] = useState(read);
  useEffect(() => {
    document.documentElement.classList.toggle('eye-sepia', on);
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [on]);
  return createPortal(
    <button
      type="button"
      className={`eye-toggle${on ? ' on' : ''}`}
      onClick={() => setOn((v) => !v)}
      aria-pressed={on}
      title={on ? 'Eye comfort is on — turn off' : 'Eye comfort: sepia, muted colors'}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
        <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="12" cy="12" r="3.2" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" />
      </svg>
      <span className="eye-label">{on ? 'Sepia on' : 'Sepia'}</span>
    </button>,
    document.body,
  );
}
