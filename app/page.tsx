"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Viewport from "@/components/Viewport";
import { parseStl, type StlMesh } from "@/lib/stl";
import { makeTorus } from "@/lib/demo";

export default function Home() {
  const [mesh, setMesh] = useState<StlMesh | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [webglOk, setWebglOk] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
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
  };

  const loadFile = useCallback(async (file: File) => {
    setError("");
    setLoading(true);
    try {
      const buf = await file.arrayBuffer();
      const m = parseStl(buf);
      setMesh(m);
      setFileName(file.name);
      toastTimer.current = setTimeout(clearToast, 6000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "NepodaĹ™ilo se naÄŤĂ­st soubor.");
      setMesh(null);
      setFileName("");
      toastTimer.current = setTimeout(clearToast, 8000);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDemo = useCallback(() => {
    setError("");
    setMesh(makeTorus());
    setFileName("demo model (donut)");
    toastTimer.current = setTimeout(clearToast, 6000);
  }, []);

  // drag & drop kamkoli na strĂˇnku
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

  const pick = () => fileRef.current?.click();

  return (
    <div className="page">
      <header>
        <div className="logo">
          slicer<span className="dot">.</span>
        </div>
        <div className="actions">
          <button className="btn btn-small btn-primary" onClick={pick}>
            Vyber modelâ€¦
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
            <div className="drop-big">PĹ™etĂˇhni svĹŻj STL sem</div>
            <div className="drop-small">
              â€¦nebo klikni na â€žVyber model" Â· nemĂˇĹˇ model? Klikni na â€žDemo"
            </div>
            <div className="drop-note">
              STEP soubory zatĂ­m neumĂ­me â€” pĹ™eveÄŹ si model do STL (napĹ™. ve
              FreeCAD / Fusion 360) a pĹ™etĂˇhni ho sem
            </div>
          </div>
        )}

        {loading && <div className="toast toast-info">NaÄŤĂ­tĂˇm modelâ€¦</div>}
        {fileName && !error && (
          <div className="toast toast-ok">
            Model naÄŤten âś“ Â· {fileName} Â·{" "}
            {mesh?.triangleCount.toLocaleString("cs-CZ")} trojĂşhelnĂ­kĹŻ
          </div>
        )}
        {error && <div className="toast toast-err">{error}</div>}
        {mesh && !webglOk && (
          <div className="toast toast-warn">
            Tento prohlĂ­ĹľeÄŤ nepodporuje 3D (WebGL) â€” zkus Chrome nebo Edge.
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
