"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Viewport from "@/components/Viewport";
import { parseStl, type StlMesh } from "@/lib/stl";
import { parseObj } from "@/lib/obj";
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
  mirrorMesh,
  totalVolume,
  fitsInVat,
  normalizeToPlate,
  DEFAULT_TRANSFORM,
  type ModelTransform,
} from "@/lib/transform";
import { sliceMesh, unionSlices, type SliceResult } from "@/lib/slice";
import { generateSupports } from "@/lib/supports";
import { applyAA } from "@/lib/aa";
import { applyHollow } from "@/lib/hollow";
import { applyRaft } from "@/lib/raft";
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
  hollow: boolean;
  wallMm: number;
  holeDiaMm: number;
  drainHoles: boolean;
  raft: boolean;
  raftLayers: number;
  raftMarginMm: number;
  zupHeight: number;
  zupSpeed: number;
  zupHeightBottom: number;
  zupSpeedBottom: number;
  supportRadiusMm: number;
  supportTipMm: number;
}

const DEFAULT_SETTINGS: SliceSettings = {
  layerHeight: 0.1,
  bottomExposure: 25,
  normalExposure: 2.5,
  bottomLayers: 5,
  supports: true,
  aa: true,
  hollow: false,
  wallMm: 2.0,
  holeDiaMm: 3.0,
  drainHoles: true,
  raft: false,
  raftLayers: 3,
  raftMarginMm: 3,
  zupHeight: 1.0,
  zupSpeed: 1.0,
  zupHeightBottom: 1.5,
  zupSpeedBottom: 0.5,
  supportRadiusMm: 1.0,
  supportTipMm: 0.5,
};

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

/** Měřítko pro slicovací rastr — vždy dělí rozlišení tiskárny beze zbytku.
 * 1/16 = 4× méně paměti než 1/8 (slice by jinak zabral stovky MB a mohl spadnout). */
function sliceScale(resX: number, resY: number): number {
  if (resX % 16 === 0 && resY % 16 === 0) return 16;
  if (resX % 8 === 0 && resY % 8 === 0) return 8;
  if (resX % 4 === 0 && resY % 4 === 0) return 4;
  if (resX % 2 === 0 && resY % 2 === 0) return 2;
  return 1;
}

let nextId = 1;

/** Akordeon sekce levé navigace. */
function SideSec({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`side-sec ${open ? "open" : ""}`}>
      <button className="side-sec-head" onClick={onToggle}>
        <span>{label}</span>
        <span className="side-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="side-sec-body">{children}</div>}
    </div>
  );
}

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
  const [settings, setSettings] = useState<SliceSettings>({
    ...DEFAULT_SETTINGS,
    ...(savedProfile?.settings ?? {}),
  });

  const [sliceResult, setSliceResult] = useState<SliceResult | null>(null);
  const [supportMask, setSupportMask] = useState<Uint8Array[] | null>(null);
  const [sliceIdx, setSliceIdx] = useState(0);
  const [slicing, setSlicing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sending, setSending] = useState(false);
  const [lastExport, setLastExport] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [exportName, setExportName] = useState("tisk");
  const [showInfo, setShowInfo] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [openSec, setOpenSec] = useState<string>("model");
  const [gizmoMode, setGizmoMode] = useState<"translate" | "rotate" | "scale">("translate");

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
    let m = translateMesh(mesh, 0, 0, -mesh.bounds.min[2]);
    // automaticky postavit nastojato, pokud je model plochý (leží na podložce)
    const w = m.bounds.max[0] - m.bounds.min[0];
    const d = m.bounds.max[1] - m.bounds.min[1];
    const h = m.bounds.max[2] - m.bounds.min[2];
    if (h < 0.25 * Math.max(w, d)) {
      m = normalizeToPlate(autoUpright(m));
    }
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
          const name = file.name.toLowerCase();
          let m: StlMesh;
          if (name.endsWith(".obj")) {
            m = parseObj(await file.text());
          } else {
            m = parseStl(await file.arrayBuffer());
          }
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

  const clearAll = useCallback(() => {
    setModels([]);
    setSelectedId(null);
    setSliceResult(null);
    setLastExport(null);
    showToast("ok", "Vše smazáno");
  }, []);

  const [light, setLight] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = light ? "light" : "dark";
  }, [light]);

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

  const removeModel = useCallback(
    (id: number) => {
      setModels((prev) => prev.filter((m) => m.id !== id));
      if (selectedId === id) setSelectedId(null);
      setSliceResult(null);
    },
    [selectedId]
  );

  const duplicateSel = useCallback(() => {
    if (!selectedId) return;
    const item = models.find((m) => m.id === selectedId);
    if (!item) return;
    const copy: ModelItem = {
      ...item,
      id: nextId++,
      name: item.name + " (kopie)",
      transform: { ...item.transform, x: item.transform.x + 30, y: item.transform.y + 30 },
    };
    setModels((prev) => [...prev, copy]);
    setSelectedId(copy.id);
    setSliceResult(null);
    showToast("ok", "Model duplikován ✓");
  }, [selectedId, models]);

  const downloadSelStl = useCallback(() => {
    if (!selected) return;
    const m = applyTransform(selected.mesh, selected.transform);
    const n = m.triangleCount;
    const buf = new ArrayBuffer(84 + n * 50);
    const v = new DataView(buf);
    v.setUint32(80, n, true);
    const cross = (a: number[], b: number[]) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    for (let i = 0; i < n; i++) {
      const o = i * 9;
      const v0 = [m.positions[o], m.positions[o + 1], m.positions[o + 2]];
      const v1 = [m.positions[o + 3], m.positions[o + 4], m.positions[o + 5]];
      const v2 = [m.positions[o + 6], m.positions[o + 7], m.positions[o + 8]];
      const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
      const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
      const nv = cross(e1, e2);
      const len = Math.hypot(nv[0], nv[1], nv[2]) || 1;
      const off = 84 + i * 50;
      v.setFloat32(off, nv[0] / len, true);
      v.setFloat32(off + 4, nv[1] / len, true);
      v.setFloat32(off + 8, nv[2] / len, true);
      for (let k = 0; k < 3; k++) {
        const p = k === 0 ? v0 : k === 1 ? v1 : v2;
        v.setFloat32(off + 12 + k * 12, p[0], true);
        v.setFloat32(off + 16 + k * 12, p[1], true);
        v.setFloat32(off + 20 + k * 12, p[2], true);
      }
      v.setUint16(off + 48, 0, true);
    }
    downloadBytes(new Uint8Array(buf), (selected.name.replace(/\.[^.]+$/, "") || "model") + ".stl");
    showToast("ok", "STL stažen ✓");
  }, [selected]);

  const computeSlice = useCallback((): { result: SliceResult | null; supportMask: Uint8Array[] | null } => {
    if (models.length === 0) return { result: null, supportMask: null };
    const scale = sliceScale(printer.resX, printer.resY);
    const sliceW = printer.resX / scale;
    const sliceH = printer.resY / scale;
    const mmPerPx = {
      x: printer.printX / sliceW,
      y: printer.printY / sliceH,
    };
    let result: SliceResult | null = null;
    for (const m of models) {
      const s = sliceMesh(m.mesh, {
        layerHeight: settings.layerHeight,
        resolutionX: sliceW,
        resolutionY: sliceH,
        plateW: printer.printX,
        plateH: printer.printY,
        offsetX: m.transform.x,
        offsetY: m.transform.y,
      });
      result = result ? unionSlices(result, s) : s;
    }
    if (result && settings.hollow) {
      result = applyHollow(
        result,
        { enabled: true, wallMm: settings.wallMm, holeDiaMm: settings.holeDiaMm, drainHoles: settings.drainHoles },
        mmPerPx
      );
    }
    let supportMask: Uint8Array[] | null = null;
    const px = Math.min(mmPerPx.x, mmPerPx.y);
    if (result && settings.supports) {
      const sr = generateSupports(result, {
        enabled: true,
        radiusPx: Math.max(2, Math.round(settings.supportRadiusMm / px)),
        tipPx: Math.max(1, Math.round(settings.supportTipMm / px)),
      });
      result = sr.result;
      supportMask = sr.mask;
    }
    if (result && settings.raft) {
      const rr = applyRaft(
        result,
        { enabled: true, layers: settings.raftLayers, marginMm: settings.raftMarginMm },
        mmPerPx
      );
      result = rr.result;
      if (supportMask) {
        const n = Math.min(supportMask.length, rr.mask.length);
        for (let i = 0; i < n; i++) {
          const a = supportMask[i];
          const b = rr.mask[i];
          for (let p = 0; p < a.length; p++) {
            if (b[p]) a[p] = 1;
          }
        }
      } else {
        supportMask = rr.mask;
      }
    }
    if (result && settings.aa) {
      result = applyAA(result);
    }
    return { result, supportMask };
  }, [models, settings, printer]);

  const doSlice = useCallback(() => {
    setSlicing(true);
    setTimeout(() => {
      try {
        const { result, supportMask: sm } = computeSlice();
        if (result) {
          setSliceResult(result);
          setSupportMask(sm);
          setSliceIdx(0);
          showToast(
            "ok",
            `Naslicováno ✓ · ${result.layers.length} vrstev · ${result.layerHeight} mm${settings.supports ? " · podpory" : ""}${settings.aa ? " · AA" : ""}`
          );
        }
      } catch (e) {
        showToast("err", e instanceof Error ? e.message : "Slicování selhalo.", 8000);
      } finally {
        setSlicing(false);
      }
    }, 30);
  }, [computeSlice, settings]);

  const estPrintTime = useMemo(() => {
    if (!sliceResult) return 0;
    const perLayer =
      settings.normalExposure +
      2 * (settings.zupHeight / Math.max(settings.zupSpeed, 0.1)) +
      2;
    const bottom =
      settings.bottomLayers *
      (settings.bottomExposure +
        2 * (settings.zupHeightBottom / Math.max(settings.zupSpeedBottom, 0.1)) +
        2);
    return Math.round(
      bottom + Math.max(0, sliceResult.layers.length - settings.bottomLayers) * perLayer
    );
  }, [sliceResult, settings]);

  const buildExport = useCallback(async (): Promise<{ bytes: Uint8Array; name: string } | null> => {
    if (!sliceResult || models.length === 0) return null;
    const bytes = await buildPm7(
      models.map((m) => applyTransform(m.mesh, m.transform)),
      sliceResult,
      {
        printer,
        bottomExposure: settings.bottomExposure,
        normalExposure: settings.normalExposure,
        bottomLayers: settings.bottomLayers,
        zupHeight: settings.zupHeight,
        zupSpeed: settings.zupSpeed,
        zupHeightBottom: settings.zupHeightBottom,
        zupSpeedBottom: settings.zupSpeedBottom,
        printTimeS: estPrintTime,
      }
    );
    return { bytes, name: `${exportName}.${printer.keySuffix}` };
  }, [sliceResult, models, settings, printer, exportName, estPrintTime]);

  const exportPm7 = useCallback(async () => {
    setExporting(true);
    try {
      const ex = await buildExport();
      if (!ex) return;
      downloadBytes(ex.bytes, ex.name);
      setLastExport(ex);
      showToast("ok", "Soubor .pm7 stažen ✓ · USB: kořen disku, ≤15 znaků, FAT32", 10000);
    } catch (e) {
      showToast("err", e instanceof Error ? e.message : "Export .pm7 selhal.", 8000);
    } finally {
      setExporting(false);
    }
  }, [buildExport]);

  const printNow = useCallback(async () => {
    if (models.length === 0) return;
    setSending(true);
    try {
      // 1) slicovat, pokud ještě není
      if (!sliceResult) {
        showToast("ok", "Slicuji…", 3000);
        const { result, supportMask: sm } = computeSlice();
        if (!result) {
          showToast("err", "Slicování selhalo.", 8000);
          return;
        }
        setSupportMask(sm);
        setSliceResult(result);
        setSliceIdx(0);
      }
      // 2) připravit soubor v paměti (bez stažení)
      const ex = await buildExport();
      if (!ex) return;
      setLastExport(ex);
      // 3) token
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
      // 4) poslat do tiskárny
      const fileId = await sendPrintToPrinter(ex.bytes, ex.name, jwt, (msg) =>
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
  }, [models, sliceResult, computeSlice, buildExport]);

  const centerSel = useCallback(() => {
    if (!selectedId) return;
    updateModel(selectedId, (m) => ({ ...m, transform: { ...m.transform, x: 0, y: 0 } }));
    showToast("ok", "Model vycentrován ✓");
  }, [selectedId, updateModel]);

  const mirrorSel = useCallback(
    (axis: "x" | "y" | "z") => {
      if (!selectedId) return;
      updateModel(selectedId, (m) => ({
        ...m,
        mesh: normalizeToPlate(mirrorMesh(m.mesh, axis)),
      }));
      showToast("ok", `Model zrcadlen podle ${axis.toUpperCase()} ✓`);
    },
    [selectedId, updateModel]
  );

  const nudgeSel = useCallback(
    (dx: number, dy: number) => {
      if (!selectedId) return;
      updateModel(selectedId, (m) => ({
        ...m,
        transform: { ...m.transform, x: m.transform.x + dx, y: m.transform.y + dy },
      }));
    },
    [selectedId, updateModel]
  );

  /** Gyro (rotate/scale) — zapíše rotaci/měřítko do dat modelu po tažení. */
  const bakeTransform = useCallback(
    (id: number, rotation: { rx: number; ry: number; rz: number }, scale: number) => {
      updateModel(id, (m) => {
        let mesh = m.mesh;
        if (Math.abs(scale - 1) > 0.001) mesh = scaleMesh(mesh, scale);
        if (rotation.rx || rotation.ry || rotation.rz) {
          mesh = normalizeToPlate(rotateMesh(mesh, rotation.rx, rotation.ry, rotation.rz));
        }
        return { ...m, mesh };
      });
    },
    [updateModel]
  );

  const arrangeAll = useCallback(() => {
    setModels((prev) =>
      prev.map((m, i) => {
        const s = SLOT_OFFSETS[i % SLOT_OFFSETS.length];
        return { ...m, transform: { ...m.transform, x: s[0], y: s[1] } };
      })
    );
    setSliceResult(null);
    showToast("ok", "Modely rozmístěny ✓");
  }, []);

  const screenshot3d = useCallback(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return;
    try {
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = "slicer-3d.png";
      a.click();
      showToast("ok", "Screenshot 3D stažen ✓");
    } catch {
      showToast("err", "Screenshot se nepodařil.", 6000);
    }
  }, []);


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

  const layerPreview = useMemo(
    () =>
      sliceResult
        ? {
            z: sliceResult.layers[sliceIdx].z,
            data: sliceResult.layers[sliceIdx].data,
            resX: sliceResult.resolutionX,
            resY: sliceResult.resolutionY,
            layerHeight: sliceResult.layerHeight,
          }
        : null,
    [sliceResult, sliceIdx]
  );

  const fmtTime = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return h > 0 ? `${h} h ${m} min` : `${m} min`;
  };
  const fmtCost = (ml: number) =>
    `$${(((ml * (resin.price ?? 220)) / 1000)).toFixed(2)}`;

  // klávesové zkratky
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      const k = e.key.toLowerCase();
      if (k === "o") orientSel();
      else if (k === "s") doSlice();
      else if (k === "e") exportPm7();
      else if (k === "d") duplicateSel();
      else if (k === "c") centerSel();
      else if (k === "r") resetSel();
      else if (k === "p") printNow();
      else if (k === "m") mirrorSel("x");
      else if (e.key === "ArrowLeft") nudgeSel(-5, 0);
      else if (e.key === "ArrowRight") nudgeSel(5, 0);
      else if (e.key === "ArrowUp") nudgeSel(0, 5);
      else if (e.key === "ArrowDown") nudgeSel(0, -5);
      else if (e.key === "Escape" && sliceResult) {
        setSliceResult(null);
        setLastExport(null);
      } else if (e.key === "Delete" && selectedId !== null) {
        removeModel(selectedId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [orientSel, doSlice, exportPm7, duplicateSel, centerSel, resetSel, printNow, mirrorSel, nudgeSel, sliceResult, removeModel]);

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
          {models.length > 0 && (
            <button className="btn btn-small btn-danger" onClick={clearAll}>
              Smazat vše
            </button>
          )}
          <button className="btn btn-small btn-ghost" onClick={() => setLight((l) => !l)}>
            {light ? "Tmavý" : "Světlý"}
          </button>
        </div>
      </header>

      <div className="workspace">
        <div className="viewport">
          <Viewport
            models={viewModels}
            selectedId={selectedId}
            onMove={onMove}
            onBake={bakeTransform}
            printer={printer}
            layerPreview={layerPreview}
            gizmoMode={gizmoMode}
            supportMask={supportMask}
          />
        </div>

        <div className="side-panel">
          <div className="side-title">Modely</div>
          {models.length === 0 ? (
            <p className="side-empty">Přidej model — „Přidat model" nahoře, nebo přetáhni soubor sem.</p>
          ) : (
            <div className="side-models">
              {models.map((m) => (
                <div key={m.id} className={`side-model ${m.id === selectedId ? "active" : ""}`}>
                  <button className="chip-name" onClick={() => setSelectedId(m.id)} title="Klikni pro výběr">
                    {m.name}
                  </button>
                  <button className="chip-x" onClick={() => removeModel(m.id)} title="Odebrat model">
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="side-title">Nástroje</div>
          <div className="tool-row">
            <button
              className={`tool-btn ${gizmoMode === "translate" ? "active" : ""}`}
              onClick={() => setGizmoMode("translate")}
              disabled={!selected}
            >
              Přesun
            </button>
            <button
              className={`tool-btn ${gizmoMode === "rotate" ? "active" : ""}`}
              onClick={() => setGizmoMode("rotate")}
              disabled={!selected}
            >
              Otočení
            </button>
            <button
              className={`tool-btn ${gizmoMode === "scale" ? "active" : ""}`}
              onClick={() => setGizmoMode("scale")}
              disabled={!selected}
            >
              Měřítko
            </button>
          </div>
          <p className="mp-hint">Aktivní nástroj = gyro na modelu — táhni přímo ve 3D.</p>

          <SideSec
            label="Model (další)"
            open={openSec === "model"}
            onToggle={() => setOpenSec(openSec === "model" ? "" : "model")}
          >
            <div className="mp-row">
              <button className="mp-btn" onClick={orientSel}>Narovnej</button>
              <button className="mp-btn" onClick={standUpSel}>Postav</button>
              <button className="mp-btn" onClick={resetSel}>Vrať</button>
              <button className="mp-btn" onClick={duplicateSel}>Duplikovat</button>
              <button className="mp-btn" onClick={centerSel}>Centrovat</button>
              <button className="mp-btn mp-danger" onClick={removeSel}>Smaž</button>
            </div>
            <div className="mp-row">
              <button className="mp-btn" onClick={() => mirrorSel("x")}>Zrcad X</button>
              <button className="mp-btn" onClick={() => mirrorSel("y")}>Zrcad Y</button>
              <button className="mp-btn" onClick={() => mirrorSel("z")}>Zrcad Z</button>
              <button className="mp-btn" onClick={downloadSelStl}>STL</button>
              <button className="mp-btn" onClick={screenshot3d}>Foto</button>
              {models.length > 1 && (
                <button className="mp-btn" onClick={arrangeAll}>Rozmístit</button>
              )}
            </div>
          </SideSec>

          <SideSec
            label="Podpory (Support)"
            open={openSec === "supports"}
            onToggle={() => setOpenSec(openSec === "supports" ? "" : "supports")}
          >
            <label className="set-row check">
              <input
                type="checkbox"
                checked={settings.supports}
                onChange={(e) => setSettings((s) => ({ ...s, supports: e.target.checked }))}
              />
              <span>Automatické podpory</span>
            </label>
            {settings.supports && (
              <>
                <label className="set-row">
                  <span>Ø podpory (mm)</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0.3}
                    value={settings.supportRadiusMm}
                    onChange={(e) => setSettings((s) => ({ ...s, supportRadiusMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Špička (mm)</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0.2}
                    value={settings.supportTipMm}
                    onChange={(e) => setSettings((s) => ({ ...s, supportTipMm: Number(e.target.value) }))}
                  />
                </label>
              </>
            )}
          </SideSec>

          <SideSec
            label="Hollowing (dutý model)"
            open={openSec === "hollow"}
            onToggle={() => setOpenSec(openSec === "hollow" ? "" : "hollow")}
          >
            <label className="set-row check">
              <input
                type="checkbox"
                checked={settings.hollow}
                onChange={(e) => setSettings((s) => ({ ...s, hollow: e.target.checked }))}
              />
              <span>Dutý model</span>
            </label>
            {settings.hollow && (
              <>
                <label className="set-row">
                  <span>Stěna (mm)</span>
                  <input
                    type="number"
                    step={0.5}
                    min={0.5}
                    value={settings.wallMm}
                    onChange={(e) => setSettings((s) => ({ ...s, wallMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Otvory Ø (mm)</span>
                  <input
                    type="number"
                    step={0.5}
                    min={1}
                    value={settings.holeDiaMm}
                    onChange={(e) => setSettings((s) => ({ ...s, holeDiaMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row check">
                  <input
                    type="checkbox"
                    checked={settings.drainHoles}
                    onChange={(e) => setSettings((s) => ({ ...s, drainHoles: e.target.checked }))}
                  />
                  <span>Odvodňovací otvory</span>
                </label>
              </>
            )}
          </SideSec>

          <SideSec
            label="Raft (základna)"
            open={openSec === "raft"}
            onToggle={() => setOpenSec(openSec === "raft" ? "" : "raft")}
          >
            <label className="set-row check">
              <input
                type="checkbox"
                checked={settings.raft}
                onChange={(e) => setSettings((s) => ({ ...s, raft: e.target.checked }))}
              />
              <span>Raft</span>
            </label>
            {settings.raft && (
              <>
                <label className="set-row">
                  <span>Vrstvy</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={settings.raftLayers}
                    onChange={(e) => setSettings((s) => ({ ...s, raftLayers: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Přesah (mm)</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={settings.raftMarginMm}
                    onChange={(e) => setSettings((s) => ({ ...s, raftMarginMm: Number(e.target.value) }))}
                  />
                </label>
              </>
            )}
          </SideSec>

          <div className="side-actions">
            <button
              className={`btn btn-small ${showSettings ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setShowSettings((s) => !s)}
            >
              Nastavení
            </button>
            <button
              className={`btn btn-small ${showInfo ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setShowInfo((s) => !s)}
            >
              Info
            </button>
          </div>
        </div>
        {models.length > 0 && (
          <div className="fab-wrap" style={{ bottom: sliceResult ? 400 : 18 }}>
            <button
              className="btn btn-fab"
              onClick={sliceResult ? printNow : doSlice}
              disabled={sending || exporting || (slicing && !sliceResult)}
            >
              {sending
                ? "Posílám…"
                : slicing && !sliceResult
                ? "Slicuji…"
                : sliceResult
                ? "Tisknout"
                : "Slicovat"}
            </button>
            <button
              className="btn btn-small btn-ghost fab-usb"
              onClick={exportPm7}
              disabled={exporting}
              title="Uložit soubor na USB (stažení .pm7)"
            >
              {exporting ? "…" : "USB"}
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
              <span>Název tisku</span>
              <input
                type="text"
                maxLength={12}
                value={exportName}
                onChange={(e) =>
                  setExportName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12))
                }
              />
            </label>
            <details open>
              <summary>Základní</summary>
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
            </details>
            <details>
              <summary>Podpory a kvalita</summary>
            <label className="set-row check">
              <input
                type="checkbox"
                checked={settings.supports}
                onChange={(e) => setSettings((s) => ({ ...s, supports: e.target.checked }))}
              />
              <span>Automatické podpory</span>
            </label>
            {settings.supports && (
              <>
                <label className="set-row">
                  <span>Podpory Ø (mm)</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0.3}
                    value={settings.supportRadiusMm}
                    onChange={(e) => setSettings((s) => ({ ...s, supportRadiusMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Špička podpory (mm)</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0.2}
                    value={settings.supportTipMm}
                    onChange={(e) => setSettings((s) => ({ ...s, supportTipMm: Number(e.target.value) }))}
                  />
                </label>
              </>
            )}
            <label className="set-row check">
              <input
                type="checkbox"
                checked={settings.aa}
                onChange={(e) => setSettings((s) => ({ ...s, aa: e.target.checked }))}
              />
            </label>
            </details>
            <details>
              <summary>Hollowing</summary>
            <label className="set-row check">
              <input
                type="checkbox"
                checked={settings.hollow}
                onChange={(e) => setSettings((s) => ({ ...s, hollow: e.target.checked }))}
              />
              <span>Hollowing (dutý model)</span>
            </label>
            {settings.hollow && (
              <>
                <label className="set-row">
                  <span>Stěna (mm)</span>
                  <input
                    type="number"
                    step={0.5}
                    min={0.5}
                    value={settings.wallMm}
                    onChange={(e) => setSettings((s) => ({ ...s, wallMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Otvory Ø (mm)</span>
                  <input
                    type="number"
                    step={0.5}
                    min={1}
                    value={settings.holeDiaMm}
                    onChange={(e) => setSettings((s) => ({ ...s, holeDiaMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row check">
                  <input
                    type="checkbox"
                    checked={settings.drainHoles}
                    onChange={(e) => setSettings((s) => ({ ...s, drainHoles: e.target.checked }))}
                  />
                  <span>Odvodňovací otvory</span>
                </label>
              </>
            )}
            </details>
            <details>
              <summary>Raft</summary>
            <label className="set-row check">
              <input
                type="checkbox"
                checked={settings.raft}
                onChange={(e) => setSettings((s) => ({ ...s, raft: e.target.checked }))}
              />
              <span>Raft (základna)</span>
            </label>
            {settings.raft && (
              <>
                <label className="set-row">
                  <span>Raft vrstvy</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={settings.raftLayers}
                    onChange={(e) => setSettings((s) => ({ ...s, raftLayers: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Raft přesah (mm)</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={settings.raftMarginMm}
                    onChange={(e) => setSettings((s) => ({ ...s, raftMarginMm: Number(e.target.value) }))}
                  />
                </label>
              </>
            )}
            </details>
            <details>
              <summary>Zvedání</summary>
            <label className="set-row">
              <span>Zvednutí (mm)</span>
              <input
                type="number"
                step={0.1}
                min={0.1}
                value={settings.zupHeight}
                onChange={(e) => setSettings((s) => ({ ...s, zupHeight: Number(e.target.value) }))}
              />
            </label>
            <label className="set-row">
              <span>Rychlost zvedání</span>
              <input
                type="number"
                step={0.5}
                min={0.5}
                value={settings.zupSpeed}
                onChange={(e) => setSettings((s) => ({ ...s, zupSpeed: Number(e.target.value) }))}
              />
            </label>
            <label className="set-row">
              <span>Zvednutí 1. vrstev</span>
              <input
                type="number"
                step={0.1}
                min={0.1}
                value={settings.zupHeightBottom}
                onChange={(e) => setSettings((s) => ({ ...s, zupHeightBottom: Number(e.target.value) }))}
              />
            </label>
            <label className="set-row">
              <span>Rychlost 1. vrstev</span>
              <input
                type="number"
                step={0.1}
                min={0.1}
                value={settings.zupSpeedBottom}
                onChange={(e) => setSettings((s) => ({ ...s, zupSpeedBottom: Number(e.target.value) }))}
              />
            </label>
            </details>
            <p className="info-note">
              Zkratky: O narovnej · S slicuj · E export · P poslat · D duplikovat · C centrovat ·
              M zrcadlit X · šipky = posun 5 mm · R vrátit
            </p>
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
            {sliceResult && (
              <>
                <div className="info-row">
                  <span>Vrstvy</span>
                  <b>
                    {sliceResult.layers.length} · {sliceResult.layerHeight} mm
                  </b>
                </div>
                <div className="info-row">
                  <span>Čas (odhad)</span>
                  <b>{fmtTime(estPrintTime)}</b>
                </div>
              </>
            )}
            <div className="info-row">
              <span>Cena (odhad)</span>
              <b>{fmtCost(volMl)}</b>
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
          <div className="layer-bar">
            <div className="layer-bar-head">
              <span>Náhled tisku</span>
              <button
                className="slice-close"
                onClick={() => {
                  setSliceResult(null);
                  setLastExport(null);
                }}
                title="Zavřít náhled"
              >
                ×
              </button>
            </div>
            <input
              type="range"
              min={0}
              max={sliceResult.layers.length - 1}
              value={sliceIdx}
              onChange={(e) => setSliceIdx(Number(e.target.value))}
            />
            <div className="layer-bar-label">
              Vrstva {sliceIdx + 1} / {sliceResult.layers.length} · z ={" "}
              {sliceResult.layers[sliceIdx].z.toFixed(2)} mm · {sliceResult.layerHeight} mm/vrstva
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
        accept=".stl,.obj"
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

