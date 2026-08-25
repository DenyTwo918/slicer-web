"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import Viewport from "@/components/Viewport";
import { parseStl, type StlMesh } from "@/lib/stl";
import { makeTorus } from "@/lib/demo";

export default function Home() {
  const [mesh, setMesh] = useState<StlMesh | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [webglOk, setWebglOk] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const c = document.createElement("canvas");
      setWebglOk(!!(c.getContext("webgl2") || c.getContext("webgl")));
    } catch {
      setWebglOk(false);
    }
  }, []);

  const loadFile = useCallback(async (file: File) => {
    setError("");
    setLoading(true);
    try {
      const buf = await file.arrayBuffer();
      const m = parseStl(buf);
      setMesh(m);
      setFileName(file.name);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Nepodařilo se načíst soubor."
      );
      setMesh(null);
      setFileName("");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDemo = useCallback(() => {
    setError("");
    setMesh(makeTorus());
    setFileName("demo model (donut)");
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const f = e.dataTransfer.files?.[0];
      if (f) loadFile(f);
    },
    [loadFile]
  );

  const pick = () => fileRef.current?.click();

  return (
    <div className="page">
      <header>
        <div className="logo">
          slicer<span className="dot">.</span>
        </div>
        <div className="steps">
          <div className="step-dot active">
            <span>1</span> Vlož model
          </div>
          <div className="step-dot">
            <span>2</span> Připrav
          </div>
          <div className="step-dot">
            <span>3</span> Zkontroluj
          </div>
          <div className="step-dot">
            <span>4</span> Tiskni
          </div>
        </div>
      </header>

      <main>
        <div className="card">
          <h1>Vlož model</h1>
          <p className="sub">
            Model je soubor s tvojí věcí, kterou chceš vytisknout.
          </p>

          <input
            ref={fileRef}
            type="file"
            accept=".stl,.obj,.3mf"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) loadFile(f);
              e.target.value = "";
            }}
          />

          {!mesh && (
            <>
              <div
                className="dropzone"
                onClick={pick}
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
              >
                <div className="big">Sem přetáhni svůj model</div>
                <div className="hint">
                  nebo klikni a vyber soubor (STL, OBJ, 3MF)
                </div>
              </div>
              <div className="demo-row">
                <span>Nemáš model? Vyzkoušej demo:</span>
                <button className="btn btn-ghost" onClick={loadDemo}>
                  Vyzkoušej demo model — bez souboru
                </button>
              </div>
            </>
          )}

          {loading && <div className="status show">Načítám model…</div>}
          {error && <div className="error show">{error}</div>}
          {mesh && !webglOk && (
            <div className="warn show">
              Tento prohlížeč nepodporuje 3D (WebGL). Zkus prosím Chrome nebo
              Edge — model ale můžeš i tak nahrát.
            </div>
          )}

          {mesh && (
            <>
              <div className="status show">
                Model načten ✓ · {fileName} ·{" "}
                {mesh.triangleCount.toLocaleString("cs-CZ")} trojúhelníků
              </div>
              <div className="viewport">
                <Viewport mesh={mesh} />
              </div>
              <p className="hint3d">
                Táhni myší: otáčení · kolečko: přiblížení · pravé tlačítko:
                posun
              </p>
            </>
          )}

          <div className="btn-row">
            {mesh ? (
              <button
                className="btn btn-primary"
                disabled
                title="Další kroky brzy přijdou"
              >
                Pokračovat →
              </button>
            ) : (
              <button className="btn btn-primary" onClick={pick}>
                Vyber model
              </button>
            )}
          </div>

          <details className="helpbox">
            <summary>Potřebuješ pomoc?</summary>
            <div className="body">
              Soubor s modelem najdeš na ploše nebo ve složce Stažené soubory.
              Většinou končí na .stl. Nemáš model? Stačí kliknout na tlačítko
              „Vyzkoušej demo model".
            </div>
          </details>
        </div>
      </main>
    </div>
  );
}
