"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Viewport from "@/components/Viewport";
import LayerPreview from "@/components/LayerPreview";
import { parseStl, type StlMesh } from "@/lib/stl";
import { makeTorus } from "@/lib/demo";
import {
  findBestOrientation,
  meshStats,
  rotateMesh,
  type MeshStats,
} from "@/lib/orient";
import { sliceMesh, type SliceResult } from "@/lib/slice";
import { buildPm7 } from "@/lib/pm7";

function downloadBytes(bytes: Uint8Array, name: string) {
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const [mesh, setMesh] = useState<StlMesh | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [webglOk, setWebglOk] = useState(true);
  const [stats, setStats] = useState<MeshStats | null>(null);
  const [orientMsg, setOrientMsg] = useState("");
  const [showInfo, setShowInfo] = useState(false);

  const [sliceResult, setSliceResult] = useState<SliceResult | null>(null);
  const [sliceIdx, setSliceIdx] = useState(0);
  const [slicing, setSlicing] = useState(false);
  const [exporting, setExporting] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const originalRef = useRef<StlMesh | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const c = document.createElement("canvas");
      setWebglOk(!!(c.getContext("webgl2") || c.getContext("webgl")));
    } catch {
      setWebglOk(false);
    }
  }, []);

  const clearToast = () => {
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
      toastTimer.current = null;
    }
    setFileName("");
    setError("");
    setOrientMsg("");
  };

  const applyMesh = useCallback((m: StlMesh, name: string) => {
    setMesh(m);
    setStats(meshStats(m));
    setSliceResult(null);
    setSliceIdx(0);
    setFileName(name);
    toastTimer.current = setTimeout(clearToast, 6000);
  }, []);

  const loadFile = useCallback(
    async (file: File) => {
      setError("");
      setLoading(true);
      try {
        const buf = await file.arrayBuffer();
        const m = parseStl(buf);
        originalRef.current = m;
        applyMesh(m, file.name);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Nepodařilo se načíst soubor."
        );
        setMesh(null);
        setFileName("");
        setStats(null);
        toastTimer.current = setTimeout(clearToast, 8000);
      } finally {
        setLoading(false);
      }
    },
    [applyMesh]
  );

  const loadDemo = useCallback(() => {
    const m = makeTorus();
    originalRef.current = m;
    applyMesh(m, "demo model (donut)");
  }, [applyMesh]);

  // drag & drop kamkoli na stránku
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = () => setDragOver(false);
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) loadFile(f);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [loadFile]);

  const autoOrient = useCallback(() => {
    if (!mesh) return;
    const best = findBestOrientation(mesh, 15);
    const rotated = rotateMesh(mesh, best.rx, best.ry, best.rz);
    setMesh(rotated);
    setStats(meshStats(rotated));
    setSliceResult(null);
    setOrientMsg(
      `Model natočen ✓ (X ${best.rx}°, Y ${best.ry}°) · podpora ${Math.round(
        best.proj
      )} mm²`
    );
    toastTimer.current = setTimeout(clearToast, 6000);
  }, [mesh]);

  const revert = useCallback(() => {
    if (originalRef.current) {
      setMesh(originalRef.current);
      setStats(meshStats(originalRef.current));
      setSliceResult(null);
      setFileName("Vráceno do původní polohy ✓");
      toastTimer.current = setTimeout(clearToast, 4000);
    }
  }, []);

  const doSlice = useCallback(() => {
    if (!mesh) return;
    setSlicing(true);
    setError("");
    // nech UI chvilku "načíst" a pak slice (sync pro MVP)
    setTimeout(() => {
      try {
        const res = sliceMesh(mesh, {
          layerHeight: 0.1,
          resolutionX: 1664, // 13312 / 8 (poměr desky M7)
          resolutionY: 640, // 5120 / 8
        });
        setSliceResult(res);
        setSliceIdx(0);
        setOrientMsg(
          `Naslicováno ✓ · ${res.layers.length} vrstev · 0,1 mm`
        );
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Slicování selhalo."
        );
      } finally {
        setSlicing(false);
        toastTimer.current = setTimeout(clearToast, 8000);
      }
    }, 30);
  }, [mesh]);

  const exportPm7 = useCallback(async () => {
    if (!mesh || !sliceResult) return;
    setExporting(true);
    setError("");
    try {
      const bytes = await buildPm7(mesh, sliceResult, { modelName: "model" });
      const base = fileName.replace(/\.stl$/i, "") || "model";
      downloadBytes(bytes, `${base}.pm7`);
      setOrientMsg(
        "Soubor .pm7 stažen ✓ · zkopíruj ho na USB (kořen, ≤15 znaků, FAT32)"
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export .pm7 selhal.");
    } finally {
      setExporting(false);
      toastTimer.current = setTimeout(clearToast, 10000);
    }
  }, [mesh, sliceResult, fileName]);

  const pick = () => fileRef.current?.click();

  const fmt = (n: number) =>
    n.toLocaleString("cs-CZ", { maximumFractionDigits: 1 });

  return (
    <div className="page">
      <header>
        <div className="logo">
          slicer<span className="dot">.</span>
        </div>
        <div className="actions">
          <button className="btn btn-small btn-primary" onClick={pick}>
            Vyber model…
          </button>
          <button className="btn btn-small btn-ghost" onClick={loadDemo}>
            Demo
          </button>
        </div>
      </header>

      <div className="workspace">
        <div className="viewport">
          <Viewport mesh={mesh} />
        </div>

        {!mesh && !loading && (
          <div
            className={`drop-hint ${dragOver ? "dragging" : ""}`}
            onClick={pick}
          >
            <div className="drop-big">Přetáhni svůj STL sem</div>
            <div className="drop-small">
              …nebo klikni na „Vyber model" · nemáš model? Klikni na „Demo"
            </div>
            <div className="drop-note">
              STEP soubory zatím neumíme — převeď si model do STL (např. ve
              FreeCAD / Fusion 360) a přetáhni ho sem
            </div>
          </div>
        )}

        {mesh && (
          <div className="toolbar">
            <button className="btn btn-small btn-primary" onClick={autoOrient}>
              Narovnej model
            </button>
            <button
              className="btn btn-small btn-green"
              onClick={doSlice}
              disabled={slicing}
            >
              {slicing ? "Slicuji…" : "Slicovat"}
            </button>
            {sliceResult && (
              <button
                className="btn btn-small btn-green"
                onClick={exportPm7}
                disabled={exporting}
              >
                {exporting ? "Generuji…" : "Export .pm7"}
              </button>
            )}
            <button className="btn btn-small btn-ghost" onClick={revert}>
              Vrať zpět
            </button>
            <button
              className={`btn btn-small ${
                showInfo ? "btn-primary" : "btn-ghost"
              }`}
              onClick={() => setShowInfo((s) => !s)}
            >
              Info
            </button>
          </div>
        )}

        {mesh && showInfo && stats && (
          <div className="info-panel">
            <div className="info-title">Model</div>
            <div className="info-row">
              <span>Objem</span>
              <b>
                {fmt(stats.volume)} mm³ ({fmt(stats.volume / 1000)} ml)
              </b>
            </div>
            <div className="info-row">
              <span>Rozměry</span>
              <b>
                {fmt(stats.width)} × {fmt(stats.depth)} × {fmt(stats.height)} mm
              </b>
            </div>
            <div className="info-row">
              <span>Trojúhelníky</span>
              <b>{mesh.triangleCount.toLocaleString("cs-CZ")}</b>
            </div>
            <div className="info-row">
              <span>Těžiště</span>
              <b>
                {fmt(stats.com[0])}, {fmt(stats.com[1])}, {fmt(stats.com[2])}
              </b>
            </div>
          </div>
        )}

        {sliceResult && (
          <div className="slice-panel">
            <div className="slice-head">
              <b>Vrstvy</b>
              <button
                className="slice-close"
                onClick={() => setSliceResult(null)}
              >
                × zavřít
              </button>
            </div>
            <LayerPreview sliceResult={sliceResult} layerIdx={sliceIdx} />
            <input
              type="range"
              min={0}
              max={sliceResult.layers.length - 1}
              value={sliceIdx}
              onChange={(e) => setSliceIdx(Number(e.target.value))}
            />
            <div className="slice-label">
              Vrstva {sliceIdx + 1} / {sliceResult.layers.length} · z ={" "}
              {sliceResult.layers[sliceIdx].z.toFixed(2)} mm
            </div>
          </div>
        )}

        {loading && <div className="toast toast-info">Načítám model…</div>}
        {fileName && !error && (
          <div className="toast toast-ok">
            {orientMsg || `Model načten ✓ · ${fileName}`}
          </div>
        )}
        {error && <div className="toast toast-err">{error}</div>}
        {mesh && !webglOk && (
          <div className="toast toast-warn">
            Tento prohlížeč nepodporuje 3D (WebGL) — zkus Chrome nebo Edge.
          </div>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".stl"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) loadFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
