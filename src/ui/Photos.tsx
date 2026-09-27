import { useEffect, useRef, useState } from 'react';
import { formatShort } from '../lib/dates';
import type { PhotoRecord } from '../lib/db';
import { useBackHandler } from './back';
import { ChevronLeft, CloseIcon, PlusIcon, TrashIcon } from './icons';
import type { Workspace } from './workspace';

/** Photos attached to one day, as a masonry grid. */
export function PhotosScreen({ ws, date, onBack }: { ws: Workspace; date: string; onBack: () => void }) {
  const photos = useDayPhotos(ws, date);
  const [viewing, setViewing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      await ws.photos.add(date, Array.from(files));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar safe-top">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <ChevronLeft />
        </button>
        <h2>{formatShort(date)}</h2>
        <label className={`btn small-btn${busy ? ' disabled' : ''}`}>
          <PlusIcon /> {busy ? 'Adding…' : 'Add'}
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            disabled={busy}
            onChange={(e) => {
              void add(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </header>
      <div className="scroll">
        {error && <p className="error pad">{error}</p>}
        {photos && photos.length === 0 && !busy && <p className="muted pad empty">No photos for this day yet.</p>}
        <div className="masonry">
          {photos?.map((p, i) => <Tile key={p.path} ws={ws} photo={p} onOpen={() => setViewing(i)} />)}
        </div>
        <div className="safe-bottom" />
      </div>
      {viewing !== null && photos && photos[viewing] && (
        <Viewer
          ws={ws}
          photos={photos}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
          onDelete={async (p) => {
            if (!window.confirm('Remove this photo from the day?')) return;
            await ws.photos.remove(p.path);
            setViewing(photos.length > 1 ? Math.max(0, Math.min(viewing, photos.length - 2)) : null);
          }}
        />
      )}
    </div>
  );
}

/** Live list of a day's photos. */
export function useDayPhotos(ws: Workspace, date: string): PhotoRecord[] | null {
  const [photos, setPhotos] = useState<PhotoRecord[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => ws.db.photosFor(date).then((p) => alive && setPhotos(p));
    void load();
    const off = ws.db.onPhotoChange((e) => e.dates.includes(date) && void load());
    return () => {
      alive = false;
      off();
    };
  }, [ws, date]);
  return photos;
}

function usePhotoUrl(ws: Workspace, photo: PhotoRecord, kind: 'thumb' | 'full') {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    ws.photos.url(photo, kind).then(
      (u) => alive && setUrl(u),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [ws, photo, kind]);
  return { url, failed };
}

function Tile({ ws, photo, onOpen }: { ws: Workspace; photo: PhotoRecord; onOpen: () => void }) {
  const { url, failed } = usePhotoUrl(ws, photo, 'thumb');
  const ratio = photo.width && photo.height ? `${photo.width} / ${photo.height}` : '4 / 3';
  return (
    <button className="tile" style={{ aspectRatio: ratio }} onClick={onOpen}>
      {url ? <img src={url} alt="" /> : <span className="muted small">{failed ? 'Offline' : 'Loading…'}</span>}
      {photo.state === 'local' && <span className="tile-badge">Not backed up</span>}
    </button>
  );
}

/** Full-screen viewer with pinch / double-tap zoom, pan, and swipe between photos. */
function Viewer(props: {
  ws: Workspace;
  photos: PhotoRecord[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDelete: (p: PhotoRecord) => void;
}) {
  const photo = props.photos[props.index];
  const { url: full, failed } = usePhotoUrl(props.ws, photo, 'full');
  const { url: thumb } = usePhotoUrl(props.ws, photo, 'thumb');
  const zoom = useZoom(props.photos.length, (d) => props.onIndex(props.index + d), props.index);
  useBackHandler(true, props.onClose);

  return (
    <div className="viewer">
      <div className="viewer-stage" ref={zoom.ref}>
        {(full ?? thumb) && <img src={full ?? thumb!} alt="" style={{ transform: zoom.transform }} draggable={false} />}
        {!full && <div className="viewer-status">{failed ? "Couldn't download this photo" : 'Loading…'}</div>}
      </div>
      <div className="viewer-bar top safe-top">
        <button className="icon-btn light" aria-label="Close" onClick={props.onClose}>
          <CloseIcon />
        </button>
        <span>
          {props.index + 1} / {props.photos.length}
        </span>
        <button className="icon-btn light" aria-label="Delete photo" onClick={() => props.onDelete(photo)}>
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}

const MAX_SCALE = 6;

function useZoom(count: number, onStep: (delta: number) => void, index: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const tRef = useRef(t);
  tRef.current = t;
  const stepRef = useRef({ onStep, index, count });
  stepRef.current = { onStep, index, count };

  // Each photo starts un-zoomed.
  useEffect(() => setT({ s: 1, x: 0, y: 0 }), [index]);

  useEffect(() => {
    const el = ref.current!;
    const pts = new Map<number, { x: number; y: number }>();
    let start = { s: 1, x: 0, y: 0, mx: 0, my: 0, dist: 1, px: 0, py: 0 };
    let lastTap = 0;
    let moved = false;

    const rel = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
    };
    const clamp = (v: { s: number; x: number; y: number }) => {
      const r = el.getBoundingClientRect();
      const s = Math.min(MAX_SCALE, Math.max(1, v.s));
      const mx = ((s - 1) * r.width) / 2;
      const my = ((s - 1) * r.height) / 2;
      return { s, x: Math.min(mx, Math.max(-mx, v.x)), y: Math.min(my, Math.max(-my, v.y)) };
    };
    const begin = () => {
      const [a, b] = [...pts.values()];
      const cur = tRef.current;
      if (b) {
        start = { ...cur, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, px: 0, py: 0 };
      } else if (a) {
        start = { ...cur, mx: 0, my: 0, dist: 1, px: a.x, py: a.y };
      }
    };

    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, rel(e));
      moved = false;
      begin();
    };
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, rel(e));
      const [a, b] = [...pts.values()];
      if (b) {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const s = Math.min(MAX_SCALE, Math.max(1, (start.s * Math.hypot(a.x - b.x, a.y - b.y)) / start.dist));
        // Keep the image point under the fingers' midpoint fixed.
        const ix = (start.mx - start.x) / start.s;
        const iy = (start.my - start.y) / start.s;
        setT(clamp({ s, x: mx - s * ix, y: my - s * iy }));
        moved = true;
      } else if (a) {
        const dx = a.x - start.px;
        const dy = a.y - start.py;
        if (Math.hypot(dx, dy) > 8) moved = true;
        if (start.s > 1) setT(clamp({ s: start.s, x: start.x + dx, y: start.y + dy }));
        else setT({ s: 1, x: dx, y: 0 }); // swipe preview
      }
    };
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      const p = pts.get(e.pointerId)!;
      pts.delete(e.pointerId);
      if (pts.size > 0) {
        begin();
        return;
      }
      const cur = tRef.current;
      if (start.s === 1 && cur.s === 1) {
        const { onStep, index, count } = stepRef.current;
        if (cur.x < -60 && index < count - 1) onStep(1);
        else if (cur.x > 60 && index > 0) onStep(-1);
        setT({ s: 1, x: 0, y: 0 });
      }
      if (!moved) {
        const now = Date.now();
        if (now - lastTap < 300) {
          // Double tap: zoom in around the tap, or back out.
          if (cur.s > 1) setT({ s: 1, x: 0, y: 0 });
          else setT(clamp({ s: 2.5, x: p.x - 2.5 * p.x, y: p.y - 2.5 * p.y }));
          lastTap = 0;
        } else lastTap = now;
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left - r.width / 2;
      const py = e.clientY - r.top - r.height / 2;
      const cur = tRef.current;
      const s = Math.min(MAX_SCALE, Math.max(1, cur.s * Math.exp(-e.deltaY / 300)));
      setT(clamp({ s, x: px - (s * (px - cur.x)) / cur.s, y: py - (s * (py - cur.y)) / cur.s }));
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
    };
  }, []);

  return { ref, transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`, scale: t.s };
}
