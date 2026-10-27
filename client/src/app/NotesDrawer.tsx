import { useEffect, useRef, useState } from 'react';
import type { BookNote, NoteTab } from '@hyperfocus/shared';
import { NoteBoard } from './NoteBoard';
import { NoteTabs } from './NoteTabs';
import type { SaveStatus } from './autosave';

const SAVE_TEXT: Record<SaveStatus, string> = { saved: 'Saved', dirty: 'Saving…', saving: 'Saving…', error: 'Not saved, retrying…' };

const HEIGHT_KEY = 'hyperfocus-notes-height';
const MIN_VH = 22;
const MAX_VH = 92;

const readHeight = () => {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return v >= MIN_VH && v <= MAX_VH ? v : 52;
  } catch {
    return 52;
  }
};

/**
 * Writing notes: a note board that slides up from the bottom of the browser (like Excalidraw; free text boxes).
 * Drag its edge up or down to set its height. Alt+N opens and closes it.
 */
export function NotesDrawer({
  notes,
  onChange,
  tabs,
  onTabsChange,
  title = 'Writing notes',
  viewKey,
  open: openProp,
  onOpenChange,
  status = 'saved',
  full = false,
}: {
  notes: BookNote[];
  onChange: (notes: BookNote[]) => void;
  /** Note tabs; if empty, a single “Page 1” tab is assumed. */
  tabs: NoteTab[];
  onTabsChange: (tabs: NoteTab[], notes?: BookNote[]) => void;
  title?: string;
  /** The key the board's scroll/zoom state is stored under. */
  viewKey: string;
  /** When given, open/closed is controlled from outside (e.g. the Notes notebook on the shelf). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The notes' save status (shown at the top right). */
  status?: SaveStatus;
  /** Opens full page (the Notes notebook on the shelf): no height handle, closes with the X at the top right. */
  full?: boolean;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const openRef = useRef(open);
  openRef.current = open;
  const setOpen = (v: boolean | ((o: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(openRef.current) : v;
    setOpenState(next);
    onOpenChange?.(next);
  };
  const [vh, setVh] = useState(readHeight);

  // ---- Tabs: each tab is a separate board ----
  const allTabs: NoteTab[] = tabs.length ? tabs : [{ id: 'main', name: 'Page 1' }];
  const tabKey = `${viewKey}:tab`;
  const [activeState, setActiveState] = useState<string>(() => {
    try {
      return localStorage.getItem(tabKey) ?? '';
    } catch {
      return '';
    }
  });
  const active = allTabs.some((t) => t.id === activeState) ? activeState : allTabs[0]!.id;
  const setActive = (id: string) => {
    setActiveState(id);
    try {
      localStorage.setItem(tabKey, id);
    } catch {
      /* ignore */
    }
  };
  const tabOf = (n: BookNote) => (n.tab && allTabs.some((t) => t.id === n.tab) ? n.tab : allTabs[0]!.id);
  const boardNotes = notes.filter((n) => tabOf(n) === active);
  const changeBoard = (next: BookNote[]) => onChange([...notes.filter((n) => tabOf(n) !== active), ...next.map((n) => ({ ...n, tab: active }))]);
  const drawerRef = useRef<HTMLElement>(null);

  // Alt+N: open / close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Closes on a click outside the notebook (not counting the click that opened it, confirm dialogs and pop-up menus)
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;
  useEffect(() => {
    if (!open) return;
    const openedAt = performance.now();
    const onDown = (e: PointerEvent) => {
      if (performance.now() - openedAt < 250) return;
      const t = e.target as Element | null;
      if (!t || drawerRef.current?.contains(t)) return;
      if (t.closest?.('.dlg-backdrop, .dlg, .nt-tab, .sp-menu, .st-toast, .toast, .eye-toggle')) return;
      setOpenRef.current(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // On opening, focus the board (so keyboard shortcuts work)
  useEffect(() => {
    if (open) window.setTimeout(() => drawerRef.current?.querySelector<HTMLElement>('.ex-board')?.focus({ preventScroll: true }), 350);
  }, [open]);

  // Height by dragging the edge
  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Flicked down fast, the notebook closes; its height goes back to what it was before the drag.
    const startVh = vh;
    const startY = e.clientY;
    const samples: { y: number; t: number }[] = [{ y: e.clientY, t: performance.now() }];
    let rawVh = startVh;
    const move = (ev: PointerEvent) => {
      const t = performance.now();
      samples.push({ y: ev.clientY, t });
      while (samples.length > 2 && t - samples[0]!.t > 80) samples.shift();
      rawVh = ((window.innerHeight - ev.clientY) / window.innerHeight) * 100;
      setVh(Math.max(MIN_VH, Math.min(MAX_VH, rawVh)));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const t = performance.now();
      const first = samples[0]!;
      const speed = (ev.clientY - first.y) / Math.max(1, t - first.t); // px/ms, downwards positive
      const flung = speed > 0.6 && ev.clientY - startY > 24;
      const pushedPastMin = rawVh < MIN_VH - 6;
      if (flung || pushedPastMin) {
        // It slides down from where it was let go; the old height comes back only after the close finishes (while invisible)
        setOpen(false);
        window.setTimeout(() => setVh(startVh), 560);
        return;
      }
      setVh((v) => {
        try {
          localStorage.setItem(HEIGHT_KEY, String(Math.round(v)));
        } catch {
          /* ignore */
        }
        return v;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <>
      {/* The bottom "Notes" tab only in the editor; on the shelf the notebook opens from the book itself */}
      {!full && (
        <button type="button" className={`nt-tab${open ? ' hidden' : ''}`} onClick={() => setOpen(true)} title="Open notes (Alt+N)">
          Notes
        </button>
      )}
      <section
        ref={drawerRef}
        className={`nt-drawer${open ? ' open' : ''}${full ? ' full' : ''}`}
        style={full ? undefined : { height: `${vh}vh` }}
        aria-label={title}
        aria-hidden={!open}
      >
        {!full && (
          <div className="nt-grip" onPointerDown={startResize} title="Drag to resize">
            <span />
          </div>
        )}
        <header className="nt-head">
          <NoteTabs
            tabs={allTabs}
            active={active}
            counts={Object.fromEntries(allTabs.map((t) => [t.id, notes.filter((n) => tabOf(n) === t.id).length]))}
            onSelect={setActive}
            onChange={(next, removedId) => {
              // The notes of a deleted tab go too; the remaining notes keep their tab
              const kept = removedId ? notes.filter((n) => tabOf(n) !== removedId).map((n) => ({ ...n, tab: tabOf(n) })) : undefined;
              onTabsChange(next, kept);
              if (removedId === active) setActive(next[0]!.id);
            }}
            onAdd={(tab) => {
              onTabsChange([...allTabs, tab], notes.map((n) => ({ ...n, tab: tabOf(n) })));
              setActive(tab.id);
            }}
          />
          <div className="nt-spacer" />
          <span className="nt-sub">{boardNotes.length ? `${boardNotes.length} ${boardNotes.length === 1 ? 'note' : 'notes'}` : 'Empty page'}</span>
          <span className={`nt-save ${status}`} role="status" aria-live="polite">
            {status === 'saved' && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12.5l4.5 4.5L19 7" />
              </svg>
            )}
            {SAVE_TEXT[status]}
          </span>
          {full && (
            <button type="button" className="nt-x" onClick={() => setOpen(false)} title="Close notes (Alt+N)" aria-label="Close notes">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </header>
        <NoteBoard key={active} notes={boardNotes} onChange={changeBoard} viewKey={`${viewKey}:${active}`} />
      </section>
    </>
  );
}
