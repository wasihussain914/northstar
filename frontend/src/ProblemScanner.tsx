import { useCallback, useEffect, useRef, useState } from "react";
import { readProblem } from "./api";

/** What a successful scan hands back to the app. */
export interface ScannedProblem {
  problem: string;
  latex: string;
  /** The cropped region, as a PNG data URL, for the destination card. */
  image: string;
}

interface Props {
  onUse: (p: ScannedProblem) => void;
  onClose: () => void;
}

/** Longest side of the working page render; keeps memory and upload sane. */
const PAGE_MAX = 2200;
/** Longest side of the crop we send to the server. */
const CROP_MAX = 1600;

interface Page {
  canvas: HTMLCanvasElement;
  url: string;
  /** PDF only. */
  pageNum?: number;
  pageCount?: number;
}

type Rect = { x: number; y: number; w: number; h: number };

/**
 * Point the camera at homework (or open a photo / PDF), drag a box around the
 * problem, and let the tutor read it. Shown as a full-screen sheet.
 */
export function ProblemScanner({ onUse, onClose }: Props) {
  const [page, setPage] = useState<Page | null>(null);
  const [pdf, setPdf] = useState<unknown>(null);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [busy, setBusy] = useState<"load" | "read" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const showCanvas = (canvas: HTMLCanvasElement, extra?: Partial<Page>) => {
    setPage({ canvas, url: canvas.toDataURL("image/png"), ...extra });
    setCrop(null);
    setError(null);
  };

  const loadImage = (file: File) =>
    new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, PAGE_MAX / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(img.src);
        showCanvas(canvas);
        resolve();
      };
      img.onerror = () => reject(new Error("Couldn't open that image."));
      img.src = URL.createObjectURL(file);
    });

  const renderPdfPage = useCallback(async (doc: any, pageNum: number) => {
    const p = await doc.getPage(pageNum);
    const base = p.getViewport({ scale: 1 });
    const scale = PAGE_MAX / Math.max(base.width, base.height);
    const viewport = p.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await p.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
    showCanvas(canvas, { pageNum, pageCount: doc.numPages });
  }, []);

  const loadPdf = async (file: File) => {
    // Loaded on demand so the main bundle stays light.
    const pdfjs = await import("pdfjs-dist");
    const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = worker;
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    setPdf(doc);
    await renderPdfPage(doc, 1);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy("load");
    setError(null);
    try {
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) await loadPdf(file);
      else await loadImage(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const turnPage = async (delta: number) => {
    if (!pdf || !page?.pageNum || !page.pageCount) return;
    const next = page.pageNum + delta;
    if (next < 1 || next > page.pageCount) return;
    setBusy("load");
    try {
      await renderPdfPage(pdf, next);
    } finally {
      setBusy(null);
    }
  };

  const use = async () => {
    if (!page) return;
    const src = page.canvas;
    // No crop drawn = use the whole page.
    const r = crop && crop.w > 8 && crop.h > 8 ? crop : { x: 0, y: 0, w: src.width, h: src.height };
    const scale = Math.min(1, CROP_MAX / Math.max(r.w, r.h));
    const out = document.createElement("canvas");
    out.width = Math.round(r.w * scale);
    out.height = Math.round(r.h * scale);
    out.getContext("2d")!.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
    const image = out.toDataURL("image/png");
    setBusy("read");
    setError(null);
    try {
      const read = await readProblem(image);
      onUse({ ...read, image });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  return (
    <div className="scanner-backdrop" onClick={onClose}>
      <div className="scanner" role="dialog" aria-label="Scan your homework" onClick={(e) => e.stopPropagation()}>
        <header className="scanner-head">
          <h2>{page ? "Box the problem you're solving" : "Scan your homework"}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {!page ? (
          <div className="scanner-pick">
            <button className="pick-tile" onClick={() => cameraRef.current?.click()}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                <circle cx="12" cy="13.5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
              </svg>
              <strong>Take a photo</strong>
              <span>Point the camera at the page</span>
            </button>
            <button className="pick-tile" onClick={() => fileRef.current?.click()}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                <path d="M14 3v4h4M9 13h6M9 16.5h6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <strong>Open a photo or PDF</strong>
              <span>A worksheet, a textbook page, homework</span>
            </button>
            {busy === "load" && <p className="scanner-note">Opening…</p>}
          </div>
        ) : (
          <>
            <CropStage url={page.url} canvas={page.canvas} crop={crop} onCrop={setCrop} />
            <footer className="scanner-foot">
              <div className="scanner-foot-left">
                <button className="btn ghost" onClick={() => { setPage(null); setPdf(null); setCrop(null); }}>
                  Different page
                </button>
                {page.pageCount != null && page.pageCount > 1 && (
                  <span className="page-nav">
                    <button className="icon-btn" onClick={() => turnPage(-1)} disabled={page.pageNum === 1 || !!busy} aria-label="Previous page">
                      <svg viewBox="0 0 20 20"><path d="M12 4l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                    {page.pageNum} / {page.pageCount}
                    <button className="icon-btn" onClick={() => turnPage(1)} disabled={page.pageNum === page.pageCount || !!busy} aria-label="Next page">
                      <svg viewBox="0 0 20 20"><path d="M8 4l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                  </span>
                )}
              </div>
              <button className="btn primary" onClick={use} disabled={busy === "read"}>
                {busy === "read" ? "Reading…" : crop && crop.w > 8 ? "Use this problem" : "Use the whole page"}
              </button>
            </footer>
          </>
        )}

        {error && <p className="scanner-error">{error}</p>}

        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        <input ref={fileRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => onFile(e.target.files?.[0])} />
      </div>
    </div>
  );
}

/** The page with a draggable crop box over it. Coordinates live in page-canvas space. */
function CropStage({ url, canvas, crop, onCrop }: {
  url: string;
  canvas: HTMLCanvasElement;
  crop: Rect | null;
  onCrop: (r: Rect | null) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const gesture = useRef<{ mode: "draw" | "move"; startX: number; startY: number; base: Rect | null } | null>(null);

  const toPage = (e: React.PointerEvent): [number, number] => {
    const rect = imgRef.current!.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return [
      Math.max(0, Math.min(canvas.width, (e.clientX - rect.left) * sx)),
      Math.max(0, Math.min(canvas.height, (e.clientY - rect.top) * sy)),
    ];
  };

  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const [x, y] = toPage(e);
    const inside = crop && x >= crop.x && x <= crop.x + crop.w && y >= crop.y && y <= crop.y + crop.h;
    gesture.current = inside
      ? { mode: "move", startX: x, startY: y, base: crop }
      : { mode: "draw", startX: x, startY: y, base: null };
    if (!inside) onCrop({ x, y, w: 0, h: 0 });
  };

  const move = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const [x, y] = toPage(e);
    if (g.mode === "draw") {
      onCrop({
        x: Math.min(g.startX, x),
        y: Math.min(g.startY, y),
        w: Math.abs(x - g.startX),
        h: Math.abs(y - g.startY),
      });
    } else if (g.base) {
      const nx = Math.max(0, Math.min(canvas.width - g.base.w, g.base.x + (x - g.startX)));
      const ny = Math.max(0, Math.min(canvas.height - g.base.h, g.base.y + (y - g.startY)));
      onCrop({ ...g.base, x: nx, y: ny });
    }
  };

  const up = () => {
    const g = gesture.current;
    gesture.current = null;
    // A tap (not a drag) clears the box back to "whole page".
    if (g?.mode === "draw" && crop && (crop.w < 8 || crop.h < 8)) onCrop(null);
  };

  const box = crop && imgRef.current
    ? (() => {
        const rect = imgRef.current.getBoundingClientRect();
        const sx = rect.width / canvas.width;
        const sy = rect.height / canvas.height;
        return { left: crop.x * sx, top: crop.y * sy, width: crop.w * sx, height: crop.h * sy };
      })()
    : null;

  return (
    <div className="crop-stage">
      <div className="crop-wrap" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <img ref={imgRef} src={url} alt="Your homework page" draggable={false} />
        {box && box.width > 2 && (
          <div className="crop-box" style={box}>
            <i /><i /><i /><i />
          </div>
        )}
      </div>
      <p className="scanner-note">
        Drag a box around one problem{crop ? " — or drag the box to move it" : ""}. No box = the whole page.
      </p>
    </div>
  );
}
