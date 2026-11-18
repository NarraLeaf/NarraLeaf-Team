/**
 * Choosing which part of a picture becomes the avatar: drag it inside the
 * circle, zoom with the slider or the wheel, and it is cut to a 256px WebP in
 * the browser - which also drops whatever the original file said about where
 * and on what it was taken.
 */
import { useEffect, useRef, useState } from "react";

import { t } from "./i18n";

const VIEW = 260;
const OUT = 256;

export function AvatarCropper({ file, done, cancel }: { file: File; done: (blob: Blob) => void; cancel: () => void }) {
  const [image, setImage] = useState<HTMLImageElement | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | undefined>(undefined);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const element = new Image();
    element.onload = () => setImage(element);
    element.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // The scale at which the picture just covers the circle; zoom is on top of it.
  const base = image === undefined ? 1 : VIEW / Math.min(image.naturalWidth, image.naturalHeight);
  const scale = base * zoom;
  const width = (image?.naturalWidth ?? 0) * scale;
  const height = (image?.naturalHeight ?? 0) * scale;
  // Kept so the picture always covers the whole circle.
  const clamp = (x: number, y: number) => ({
    x: Math.min(0, Math.max(VIEW - width, x)),
    y: Math.min(0, Math.max(VIEW - height, y)),
  });
  useEffect(() => {
    setOffset(() => clamp((VIEW - width) / 2, (VIEW - height) / 2));
    // Centred whenever the picture or the zoom changes from the slider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image]);

  const setZoomAround = (next: number) => {
    const z = Math.min(4, Math.max(1, next));
    const ratio = z / zoom;
    const cx = VIEW / 2;
    setZoom(z);
    const nw = (image?.naturalWidth ?? 0) * base * z;
    const nh = (image?.naturalHeight ?? 0) * base * z;
    const x = cx - (cx - offset.x) * ratio;
    const y = cx - (cx - offset.y) * ratio;
    setOffset({ x: Math.min(0, Math.max(VIEW - nw, x)), y: Math.min(0, Math.max(VIEW - nh, y)) });
  };

  const save = async () => {
    if (image === undefined) return;
    setBusy(true);
    const canvas = document.createElement("canvas");
    canvas.width = OUT;
    canvas.height = OUT;
    const context = canvas.getContext("2d");
    if (context === null) return;
    const sx = -offset.x / scale;
    const sy = -offset.y / scale;
    const side = VIEW / scale;
    context.drawImage(image, sx, sy, side, side, 0, 0, OUT, OUT);
    canvas.toBlob(
      (blob) => {
        setBusy(false);
        if (blob !== null) done(blob);
      },
      "image/webp",
      0.88,
    );
  };

  return (
    <div className="palette-backdrop" role="presentation" onClick={cancel}>
      <div className="cropper" role="dialog" aria-label={t("cropTitle")} onClick={(event) => event.stopPropagation()}>
        <h2>{t("cropTitle")}</h2>
        <div
          className="cropper-view"
          style={{ width: VIEW, height: VIEW }}
          onPointerDown={(event) => {
            drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (start === undefined) return;
            setOffset(clamp(start.ox + event.clientX - start.x, start.oy + event.clientY - start.y));
          }}
          onPointerUp={() => {
            drag.current = undefined;
          }}
          onWheel={(event) => setZoomAround(zoom * Math.exp(-event.deltaY * 0.002))}
        >
          {image === undefined ? null : (
            <img src={image.src} alt="" draggable={false} style={{ width, height, transform: `translate(${offset.x}px, ${offset.y}px)` }} />
          )}
          <span className="cropper-mask" aria-hidden="true" />
        </div>
        <label className="cropper-zoom">
          <span className="muted small">{t("zoom")}</span>
          <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(event) => setZoomAround(Number(event.target.value))} />
        </label>
        <div className="actions">
          <button className="ghost outline" onClick={cancel}>
            {t("cancel")}
          </button>
          <button className="primary" onClick={() => void save()} disabled={image === undefined || busy}>
            {t("cropSave")}
          </button>
        </div>
      </div>
    </div>
  );
}
