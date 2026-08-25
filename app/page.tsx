"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Viewport from "@/components/Viewport";
import LayerPreview from "@/components/LayerPreview";
import { parseStl, type StlMesh } from "@/lib/stl";
import { makeTorus, makeBox } from "@/lib/demo";
import {
  findBestOrientation,
  meshStats,
  rotateMesh as orientRotate,
  autoUpright,
  type MeshStats,
} from "@/lib/orient";
import {
  applyTransform,
  translateMesh,
  rotateMesh,
  scaleMesh,
  totalVolume,
  fitsInVat,
  normalizeToPlate,
  DEFAULT_TRANSFORM,
  type ModelTransform,
} from "@/lib/transform";
import { sliceMesh, unionSlices, type SliceResult } from "@/lib/slice";
import { generateSupports } from "@/lib/supports";
import { applyAA } from "@/lib/aa";
import { buildPm7 } from "@/lib/pm7";
import { sendPrintToPrinter, getStoredJwt, setStoredJwt } from "@/lib/anycubic";
import {
  PRINTERS,
  RESINS,
  FILMS,
  getPrinter,
  getResin,
  getFilm,
  loadSavedProfile,
  saveProfile,
  DEFAULT_PRINTER_ID,
  DEFAULT_RESIN_ID,
  DEFAULT_FILM_ID,
} from "@/lib/profiles";

interface ModelItem {
  id: number;
  name: string;
  mesh: StlMesh; // aktuální data (rotace/scale aplikované)
  original: StlMesh;
  transform: ModelTransform; // pozice na desce
}

interface SliceSettings {
  layerHeight: number;
  bottomExposure: number;
  normalExposure: number;
  bottomLayers: number;
  supports: boolean;
  aa: boolean;
}

const SLOT_OFFSETS: [number, number][] = [
  [0, 0],
  [-70, 0],
  [70, 0],
  [-35, 45],
  [35, 45],
  [0, -50],
  [-105, 0],
  [105, 0],
];

/** Měřítko pro slicovací rastr — vždy dělí rozlišení tiskárny beze zbytku. */
function sliceScale(resX: number, resY: number): number {
  if (resX % 8 === 0 && resY % 8 === 0) return 8;
  if (resX % 4 === 0 && resY % 4 === 0) return 4;
  if (resX % 2 === 0 && resY % 2 === 0) return 2;
  return 1;
}

let nextId = 1;

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
  const [savedProfile] = useState(loadSavedProfile);
  const [printerId, setPrinterId] = useState<string>(
    savedProfile?.printerId ?? DEFAULT_PRINTER_ID
  );
  const [resinId, setResinId] = useState<string>(
    savedProfile?.resinId ?? DEFAULT_RESIN_ID
  );
  const [filmId, setFilmId] = useState<string>(
    savedProfile?.filmId ?? DEFAULT_FILM_ID
  );
  const [models, setModels] = useState<ModelItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [settings, setSettings] = useState<SliceSettings>(
    savedProfile?.settings ?? {
      layerHeight: 0.1,
      bottomExposure: 25,
      normalExposure: 2.5,
      bottomLayers: 5,
      supports: true,
      aa: true,
    }
  );

  const [sliceResult, setSliceResult] = useState<SliceResult | null>(null);
  const [sliceIdx, setSliceIdx] = useState(0);
  const [slicing, setSlicing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sending, setSending] = useState(false);
  const [lastExport, setLastExport] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [toast, setToast] = useState<{ type: string; text: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (type: "ok" | "err", text: string, ms = 6000) => {
    setToast({ type, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  };

  const addModel = useCallback((mesh: StlMesh, name: string) => {
    // postavit na desku (minZ = 0)
    const m = translateMesh(mesh, 0, 0, -mesh.bounds.min[2]);
    const slot = SLOT_OFFSETS[modelsRef.current.length % SLOT_OFFSETS.length];
    const item: ModelItem = {
      id: nextId++,
      name,
      mesh: m,
      original: m,
      transform: { ...DEFAULT_TRANSFORM, x: slot[0], y: slot[1] },
    };
    setModels((prev) => [...prev, item]);
    setSelectedId(item.id);
    setSliceResult(null);
    showToast("ok", `Model přidán ✓ · ${name}`);
  }, []);

  // ref na aktuální modely (pro addModel bez závislosti)
  const modelsRef = useRef<ModelItem[]>([]);
  useEffect(() => {
    modelsRef.current = models;
  }, [models]);

  const loadFiles = useCallback(
    async (files: FileList | File[]) => {
      setLoading(true);
      for (const file of Array.from(files)) {
        try {
          const buf = await file.arrayBuffer();
          const m = parseStl(buf);
          addModel(m, file.name);
        } catch (e) {
          showToast("err", e instanceof Error ? e.message : "Nepodařilo se načíst soubor.", 8000);
        }
      }
      setLoading(false);
    },
    [addModel]
  );

  const loadDemo = useCallback(() => addModel(makeTorus(), "demo (donut)"), [addModel]);
  const loadCube = useCallback(() => addModel(makeBox(), "krychle 40×40×60"), [addModel]);

  // drag & drop kamkoli
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = () => setDragOver(false);
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = e.dataTransfer?.files;
      if (files && files.length) loadFiles(files);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [loadFiles]);

  const printer = getPrinter(printerId);
  const resin = getResin(resinId);
  const film = getFilm(filmId);

  // uložení poslední volby (tiskárna / pryskyřice / fólie / nastavení)
  useEffect(() => {
    saveProfile({ printerId, resinId, filmId, settings });
  }, [printerId, resinId, filmId, settings]);

  const selectResin = useCallback(
    (id: string) => {
      setResinId(id);
      const r = getResin(id);
      const f = getFilm(filmId);
      setSettings((s) => ({
        ...s,
        bottomLayers: r.bottomLayers,
        bottomExposure: r.bottomExposure,
        normalExposure: Math.round(r.normalExposure * f.exposureFactor * 10) / 10,
      }));
    },
    [filmId]
  );

  const selectFilm = useCallback(
    (id: string) => {
      setFilmId(id);
      const f = getFilm(id);
      const r = getResin(resinId);
      setSettings((s) => ({
        ...s,
        normalExposure: Math.round(r.normalExposure * f.exposureFactor * 10) / 10,
      }));
    },
    [resinId]
  );

  const selected = models.find((m) => m.id === selectedId) ?? null;

  const updateModel = useCallback((id: number, fn: (m: ModelItem) => ModelItem) => {
    setModels((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
    setSliceResult(null);
  }, []);

  const onMove = useCallback(
    (id: number, x: number, y: number) => {
      updateModel(id, (m) => ({ ...m, transform: { ...m.transform, x, y } }));
    },
    [updateModel]
  );

  const rotateSel = useCallback(
    (axis: "x" | "y" | "z") => {
      if (!selectedId) return;
      const item = models.find((m) => m.id === selectedId);
      if (!item) return;
      const rx = axis === "x" ? 90 : 0;
      const ry = axis === "y" ? 90 : 0;
      const rz = axis === "z" ? 90 : 0;
      updateModel(selectedId, (m) => {
        const rotated = rotateMesh(m.mesh, rx, ry, rz);
        return { ...m, mesh: normalizeToPlate(rotated) };
      });
    },
    [selectedId, models, updateModel]
  );

  const scaleSel = useCallback(
    (factor: number) => {
      if (!selectedId) return;
      updateModel(selectedId, (m) => ({ ...m, mesh: scaleMesh(m.mesh, factor) }));
    },
    [selectedId, updateModel]
  );

  const resetSel = useCallback(() => {
    if (!selectedId) return;
    updateModel(selectedId, (m) => ({
      ...m,
      mesh: m.original,
      transform: { ...DEFAULT_TRANSFORM },
    }));
  }, [selectedId, updateModel]);

  const orientSel = useCallback(() => {
    if (!selectedId) return;
    const item = models.find((m) => m.id === selectedId);
    if (!item) return;
    const best = findBestOrientation(item.mesh, 15);
    const rotated = orientRotate(item.mesh, best.rx, best.ry, best.rz);
    updateModel(selectedId, (m) => ({ ...m, mesh: normalizeToPlate(rotated) }));
    showToast("ok", `Model natočen ✓ (X ${best.rx}°, Y ${best.ry}°)`);
  }, [selectedId, models, updateModel]);

  const standUpSel = useCallback(() => {
    if (!selectedId) return;
    const item = models.find((m) => m.id === selectedId);
    if (!item) return;
    const upright = normalizeToPlate(autoUpright(item.mesh));
    updateModel(selectedId, (m) => ({ ...m, mesh: upright }));
    showToast("ok", "Model postaven nastojato ✓");
  }, [selectedId, models, updateModel]);

  const removeSel = useCallback(() => {
    if (selectedId === null) return;
    setModels((prev) => prev.filter((m) => m.id !== selectedId));
    setSelectedId(null);
    setSliceResult(null);
  }, [selectedId]);

  const doSlice = useCallback(() => {
    if (models.length === 0) return;
    setSlicing(true);
    setTimeout(() => {
      try {
        const scale = sliceScale(printer.resX, printer.resY);
        let result: SliceResult | null = null;
        for (const m of models) {
          const s = sliceMesh(m.mesh, {
            layerHeight: settings.layerHeight,
            resolutionX: printer.resX / scale,
            resolutionY: printer.resY / scale,
            plateW: printer.printX,
            plateH: printer.printY,
            offsetX: m.transform.x,
            offsetY: m.transform.y,
          });
          result = result ? unionSlices(result, s) : s;
        }
        if (result && settings.supports) {
          result = generateSupports(result, { enabled: true });
        }
        if (result && settings.aa) {
          result = applyAA(result);
        }
        setSliceResult(result);
        setSliceIdx(0);
        showToast(
          "ok",
          `Naslicováno ✓ · ${result!.layers.length} vrstev · ${result!.layerHeight} mm${settings.supports ? " · podpory" : ""}${settings.aa ? " · AA" : ""}`
        );
      } catch (e) {
        showToast("err", e instanceof Error ? e.message : "Slicování selhalo.", 8000);
      } finally {
        setSlicing(false);
      }
    }, 30);
  }, [models, settings, printer]);

  const exportPm7 = useCallback(async () => {
    if (!sliceResult || models.length === 0) return;
    setExporting(true);
    try {
      const bytes = await buildPm7(
        models.map((m) => applyTransform(m.mesh, m.transform)),
        sliceResult,
        {
          printer,
          bottomExposure: settings.bottomExposure,
          normalExposure: settings.normalExposure,
          bottomLayers: settings.bottomLayers,
        }
      );
      downloadBytes(bytes, `tisk.${printer.keySuffix}`);
      setLastExport({ bytes, name: `tisk.${printer.keySuffix}` });
      showToast("ok", "Soubor .pm7 stažen ✓ · USB: kořen disku, ≤15 znaků, FAT32", 10000);
    } catch (e) {
      showToast("err", e instanceof Error ? e.message : "Export .pm7 selhal.", 8000);
    } finally {
      setExporting(false);
    }
  }, [sliceResult, models, settings, printer]);

  const sendToPrinter = useCallback(async () => {
    if (!lastExport) return;
    let jwt = getStoredJwt();
    if (!jwt) {
      const input = prompt(
        "Vlož Anycubic access token.\n" +
          "(najdeš ho na PC v AppData\\Local\\Anycubic\\AnycubicPhotonWorkshop_V4.1.8\\global_config.ini, řádek accessToken=...)"
      );
      if (!input) return;
      jwt = input.trim();
      setStoredJwt(jwt);
    }
    setSending(true);
    try {
      const fileId = await sendPrintToPrinter(lastExport.bytes, lastExport.name, jwt, (msg) =>
        showToast("ok", msg, 6000)
      );
      showToast(
        "ok",
        `Soubor poslán do tiskárny ✓ (file ${fileId}) · tiskárna stahuje · tisk potvrď na displeji tiskárny`,
        15000
      );
    } catch (e) {
      showToast("err", e instanceof Error ? e.message : "Odeslání do tiskárny selhalo.", 10000);
    } finally {
      setSending(false);
    }
  }, [lastExport]);

  const volMl = totalVolume(models.map((m) => applyTransform(m.mesh, m.transform))) / 1000;
  const selStats: MeshStats | null = selected ? meshStats(selected.mesh) : null;

  const viewModels = useMemo(
    () =>
      models.map((m) => ({
        id: m.id,
        mesh: m.mesh,
        transform: m.transform,
        fits: fitsInVat(m.mesh, m.transform, {
          x: printer.printX,
          y: printer.printY,
          z: printer.printZ,
        }),
      })),
    [models, printer]
  );
  const allFit = viewModels.every((m) => m.fits);

  return (
    <div className="page">
      <header>
        <div className="logo">
          slicer<span className="dot">.</span>
        </div>
        <div className="actions">
          <button className="btn btn-small btn-primary" onClick={() => fileRef.current?.click()}>
            Přidat model…
          </button>
          <button className="btn btn-small btn-ghost" onClick={loadDemo}>
            Demo
          </button>
          <button className="btn btn-small btn-ghost" onClick={loadCube}>
            Krychle
          </button>
          {selectedId !== null && (
            <button className="btn btn-small btn-danger" onClick={removeSel}>
              Smazat vybraný
            </button>
          )}
        </div>
      </header>

      <div className="workspace">
        <div className="viewport">
          <Viewport
            models={viewModels}
            selectedId={selectedId}
            onMove={onMove}
            printer={printer}
          />
        </div>

        {/* seznam modelů */}
        {models.length > 0 && (
          <div className="model-strip">
            {models.map((m) => (
              <button
                key={m.id}
                className={`model-chip ${m.id === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(m.id)}
                title="Klikni pro výběr"
              >
                {m.name}
              </button>
            ))}
          </div>
        )}

        {models.length === 0 && !loading && (
          <div
            className={`drop-hint ${dragOver ? "dragging" : ""}`}
            onClick={() => fileRef.current?.click()}
          >
            <div className="drop-big">Přetáhni svůj STL sem</div>
            <div className="drop-small">
              …nebo klikni na „Přidat model" · nemáš model? „Demo" / „Krychle"
            </div>
          </div>
        )}

        {models.length > 0 && (
          <div className="toolbar">
            <button className="btn btn-small btn-primary" onClick={orientSel} disabled={!selected}>
              Narovnej
            </button>
            <button className="btn btn-small btn-primary" onClick={standUpSel} disabled={!selected}>
              Postav
            </button>
            <button className="btn btn-small btn-ghost" onClick={() => rotateSel("x")} disabled={!selected}>
              Otoč X 90°
            </button>
            <button className="btn btn-small btn-ghost" onClick={() => rotateSel("y")} disabled={!selected}>
              Otoč Y 90°
            </button>
            <button className="btn btn-small btn-ghost" onClick={() => rotateSel("z")} disabled={!selected}>
              Otoč Z 90°
            </button>
            <button className="btn btn-small btn-ghost" onClick={() => scaleSel(1.1)} disabled={!selected}>
              +10 %
            </button>
            <button className="btn btn-small btn-ghost" onClick={() => scaleSel(0.9)} disabled={!selected}>
              −10 %
            </button>
            <button className="btn btn-small btn-ghost" onClick={resetSel} disabled={!selected}>
              Vrať
            </button>
            <button className="btn btn-small btn-green" onClick={doSlice} disabled={slicing || models.length === 0}>
              {slicing ? "Slicuji…" : "Slicovat"}
            </button>
            {sliceResult && (
              <button className="btn btn-small btn-green" onClick={exportPm7} disabled={exporting}>
                {exporting ? "Generuji…" : "Export .pm7"}
              </button>
            )}
            {lastExport && (
              <button className="btn btn-small btn-green" onClick={sendToPrinter} disabled={sending}>
                {sending ? "Posílám…" : "Poslat do tiskárny (WiFi)"}
              </button>
            )}
            <button
              className={`btn btn-small ${showInfo ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setShowInfo((s) => !s)}
            >
              Info
            </button>
            <button
              className={`btn btn-small ${showSettings ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setShowSettings((s) => !s)}
            >
              Nastavení
            </button>
          </div>
        )}

        {showSettings && (
          <div className="info-panel settings">
            <div className="info-title">Nastavení tisku</div>
            <label className="set-row">
              <span>Tiskárna</span>
              <select
                value={printerId}
                onChange={(e) => {
                  setPrinterId(e.target.value);
                  setSliceResult(null);
                }}
              >
                {PRINTERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.brand} {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="set-row">
              <span>Pryskyřice</span>
              <select value={resinId} onChange={(e) => selectResin(e.target.value)}>
                {RESINS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.brand} {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="set-row">
              <span>Fólie</span>
              <select value={filmId} onChange={(e) => selectFilm(e.target.value)}>
                {FILMS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="info-note">Poslední volba se pamatuje i po zavření stránky.</p>
            <label className="set-row">
              <span>Výška vrstvy</span>
              <select
                value={settings.layerHeight}
                onChange={(e) => setSettings((s) => ({ ...s, layerHeight: Number(e.target.value) }))}
              >
                <option value={0.02}>0,02 mm</option>
                <option value={0.03}>0,03 mm</option>
                <option value={0.05}>0,05 mm</option>
                <option value={0.1}>0,1 mm</option>
              </select>
            </label>
            <label className="set-row">
              <span>První vrstvy</span>
              <input
                type="number"
                min={1}
                max={20}
                value={settings.bottomLayers}
                onChange={(e) => setSettings((s) => ({ ...s, bottomLayers: Number(e.target.value) }))}
              />
            </label>
            <label className="set-row">
              <span>Expozice 1. vrstev (s)</span>
              <input
                type="number"
                min={1}
                step={0.5}
                value={settings.bottomExposure}
                onChange={(e) => setSettings((s) => ({ ...s, bottomExposure: Number(e.target.value) }))}
              />
            </label>
            <label className="set-row">
              <span>Expozice běžná (s)</span>
              <input
                type="number"
                min={0.5}
                step={0.1}
                value={settings.normalExposure}
                onChange={(e) => setSettings((s) => ({ ...s, normalExposure: Number(e.target.value) }))}
              />
            </label>
            <label className="set-row check">
              <input
                type="checkbox"
                checked={settings.supports}
                onChange={(e) => setSettings((s) => ({ ...s, supports: e.target.checked }))}
              />
              <span>Automatické podpory</span>
            </label>
            <label className="set-row check">
              <input
                type="checkbox"
                checked={settings.aa}
                onChange={(e) => setSettings((s) => ({ ...s, aa: e.target.checked }))}
              />
              <span>Anti-aliasing</span>
            </label>
          </div>
        )}

        {showInfo && (
          <div className="info-panel">
            <div className="info-title">Informace</div>
            <div className="info-row">
              <span>Tiskárna</span>
              <b>
                {printer.brand} {printer.name}
              </b>
            </div>
            <div className="info-row">
              <span>Pryskyřice</span>
              <b>
                {resin.brand} {resin.name} ({film.name})
              </b>
            </div>
            <div className="info-row">
              <span>Modely</span>
              <b>{models.length}</b>
            </div>
            <div className="info-row">
              <span>Vana (X×Y×Z)</span>
              <b>
                {printer.printX.toFixed(0)} × {printer.printY.toFixed(0)} × {printer.printZ.toFixed(0)} mm
              </b>
            </div>
            <div className="info-row">
              <span>Vejde se do vany</span>
              <b className={allFit ? "" : "fit-bad"}>
                {allFit ? "✓ ano" : "✗ něco přesahuje (červeně)"}
              </b>
            </div>
            <div className="info-row">
              <span>Objem celkem</span>
              <b>{volMl.toLocaleString("cs-CZ", { maximumFractionDigits: 1 })} ml</b>
            </div>
            {selected && selStats && (
              <>
                <div className="info-row">
                  <span>Vybraný</span>
                  <b>{selected.name}</b>
                </div>
                <div className="info-row">
                  <span>Rozměry</span>
                  <b>
                    {selStats.width.toFixed(1)} × {selStats.depth.toFixed(1)} × {selStats.height.toFixed(1)} mm
                  </b>
                </div>
                <div className="info-row">
                  <span>Pozice</span>
                  <b>
                    {selected.transform.x.toFixed(0)}, {selected.transform.y.toFixed(0)} mm
                  </b>
                </div>
              </>
            )}
            <p className="info-note">Přesun: vyber model a táhni 3D šipkami</p>
          </div>
        )}

        {sliceResult && (
          <div className="slice-panel">
            <div className="slice-head">
              <b>Vrstvy</b>
              <button className="slice-close" onClick={() => setSliceResult(null)}>
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
        {toast && (
          <div className={`toast ${toast.type === "ok" ? "toast-ok" : "toast-err"}`}>{toast.text}</div>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".stl"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.length) loadFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
