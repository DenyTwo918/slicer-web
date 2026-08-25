"use client";

import { useEffect, useRef } from "react";
import type { SliceResult } from "@/lib/slice";

/** Náhled jedné vrstvy slice výsledku (canvas). */
export default function LayerPreview({
  sliceResult,
  layerIdx,
}: {
  sliceResult: SliceResult;
  layerIdx: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const layer = sliceResult.layers[layerIdx];
    if (!layer) return;
    canvas.width = sliceResult.resolutionX;
    canvas.height = sliceResult.resolutionY;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(
      sliceResult.resolutionX,
      sliceResult.resolutionY
    );
    for (let i = 0; i < sliceResult.resolutionX * sliceResult.resolutionY; i++) {
      const v = layer.data[i] ? 255 : 0;
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [sliceResult, layerIdx]);

  return <canvas ref={canvasRef} className="layer-canvas" />;
}
