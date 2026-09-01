"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Viewport from "@/components/Viewport";
import { parseStl, type StlMesh } from "@/lib/stl";
import { parseObj } from "@/lib/obj";
import { extractMeshTriangles, splitConnectedShells } from "@/lib/meshSplit";
import {
  applySafeMeshRepair,
  type MeshIssueGroup,
  type MeshRepairPlan,
  type MeshRepairReport,
} from "@/lib/meshRepair";
import {
  applyRepairToModelState,
  restoreRepairBackup,
  type RepairableModel,
} from "@/lib/meshRepairModelState";
import { createMeshRepairGeneration } from "@/lib/meshRepairGeneration";
import type { MeshRepairWorkerResponse } from "@/lib/meshRepair.worker";
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
import type { SliceResult } from "@/lib/slice";
import { runSlicePipeline, type PipelineSettings, type SliceDiagnostics } from "@/lib/pipeline";
import type { SliceWorkerResponse } from "@/lib/slice.worker";
import type { SupportPreviewData } from "@/lib/supports";
import type { PrinterProfile } from "@/lib/profiles";
import { createSliceGeneration } from "@/lib/sliceGeneration";
import { buildPm7 } from "@/lib/pm7";
import {
  buildNativeLayerPreview,
  openPm7PreviewArchive,
  type Pm7PreviewArchive,
} from "@/lib/exactLayerPreview";
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

interface ModelItem extends RepairableModel<ModelTransform> {
  id: number;
  name: string;
  mesh: StlMesh; // aktuální data (rotace/scale aplikované)
  original: StlMesh;
  transform: ModelTransform; // pozice na desce
}

type MeshIssueGroupKey =
  | "degenerateTriangles"
  | "duplicateFaces"
  | "boundaryEdges"
  | "nonManifoldEdges"
  | "inconsistentWinding"
  | "tinyShells";

interface MeshAnalysisEntry {
  status: "loading" | "ready" | "error";
  report?: MeshRepairReport;
  plan?: MeshRepairPlan;
  error?: string;
}

const MESH_ISSUE_ROWS: Array<{
  key: MeshIssueGroupKey;
  label: string;
  repairable: boolean;
}> = [
  { key: "degenerateTriangles", label: "Degenerované plochy", repairable: true },
  { key: "duplicateFaces", label: "Duplicitní plochy", repairable: true },
  { key: "inconsistentWinding", label: "Obrácená orientace", repairable: true },
  { key: "boundaryEdges", label: "Otevřené hrany", repairable: false },
  { key: "nonManifoldEdges", label: "Non-manifold hrany", repairable: false },
  { key: "tinyShells", label: "Podezřele malé části", repairable: false },
];

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
  raftRim: boolean;
  raftRimWidthMm: number;
  raftRimHeightMm: number;
  zupHeight: number;
  zupSpeed: number;
  zupHeightBottom: number;
  zupSpeedBottom: number;
  supportRadiusMm: number;
  supportTipMm: number;
  supportMaxAngleDeg: number;
  supportSpacingMm: number;
  supportClearanceMm: number;
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
  raftRim: true,
  raftRimWidthMm: 2,
  raftRimHeightMm: 0.6,
  zupHeight: 1.0,
  zupSpeed: 1.0,
  zupHeightBottom: 1.5,
  zupSpeedBottom: 0.5,
  supportRadiusMm: 1.0,
  supportTipMm: 0.5,
  supportMaxAngleDeg: 35,
  supportSpacingMm: 8,
  supportClearanceMm: 1,
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
  setTimeout(() => URL.revokeObjectURL(url), 0);
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
  const [exactPreview, setExactPreview] = useState<Pm7PreviewArchive | null>(null);
  const [supportPreview, setSupportPreview] = useState<SupportPreviewData | null>(null);
  const [sliceDiagnostics, setSliceDiagnostics] = useState<SliceDiagnostics | null>(null);

  const [sliceIdx, setSliceIdx] = useState(0);
  const [slicing, setSlicing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [lastExport, setLastExport] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [exportName, setExportName] = useState("tisk");
  const [showInfo, setShowInfo] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [openSec, setOpenSec] = useState<string>("model");
  const [gizmoMode, setGizmoMode] = useState<"translate" | "rotate" | "scale">("translate");
  const [meshAnalysisByModel, setMeshAnalysisByModel] = useState<Record<number, MeshAnalysisEntry>>({});
  const [activeMeshIssue, setActiveMeshIssue] = useState<{
    modelId: number;
    group: MeshIssueGroupKey;
    sampleIndex: number;
  } | null>(null);

  const [toast, setToast] = useState<{ type: string; text: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sliceWorkerRef = useRef<Worker | null>(null);
  const sliceSeqRef = useRef(0);
  const sliceGenerationRef = useRef(createSliceGeneration());
  const meshRepairWorkerRef = useRef<Worker | null>(null);
  const meshRepairGenerationRef = useRef(createMeshRepairGeneration());
  const analyzedMeshRef = useRef(new Map<number, StlMesh>());

  /** Central invalidation also makes every in-flight slice/export response stale. */
  const invalidateSlice = useCallback(() => {
    sliceGenerationRef.current.invalidate();
    setSliceResult(null);
    setExactPreview(null);
    setSupportPreview(null);
    setSliceDiagnostics(null);
    setSliceIdx(0);
    setLastExport(null);
    setSlicing(false);
    setExporting(false);
    setSending(false);
    setExportProgress(null);
  }, []);

  /** Every settings change clears the preview while preserving the models. */
  const updateSettings = useCallback((updater: (s: SliceSettings) => SliceSettings) => {
    setSettings(updater);
    invalidateSlice();
  }, [invalidateSlice]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    sliceGenerationRef.current.invalidate();
    sliceWorkerRef.current?.terminate();
    sliceWorkerRef.current = null;
    meshRepairGenerationRef.current.clear();
    analyzedMeshRef.current.clear();
  }, []);

  const showToast = (type: "ok" | "err", text: string, ms = 6000) => {
    setToast({ type, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  };

  useEffect(() => {
    const worker = new Worker(new URL("../lib/meshRepair.worker.ts", import.meta.url));
    meshRepairWorkerRef.current = worker;
    worker.onmessage = (event: MessageEvent<MeshRepairWorkerResponse>) => {
      const response = event.data;
      if (!meshRepairGenerationRef.current.isCurrent(response)) return;
      setMeshAnalysisByModel((previous) => ({
        ...previous,
        [response.modelId]: response.ok && response.report && response.plan
          ? { status: "ready", report: response.report, plan: response.plan }
          : { status: "error", error: response.error ?? "Analýza modelu selhala." },
      }));
    };
    worker.onerror = () => {
      setMeshAnalysisByModel((previous) => Object.fromEntries(
        Object.entries(previous).map(([id, entry]) => [
          id,
          entry.status === "loading"
            ? { status: "error", error: "Worker kontroly modelu selhal." }
            : entry,
        ]),
      ));
    };
    return () => {
      worker.terminate();
      if (meshRepairWorkerRef.current === worker) meshRepairWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const worker = meshRepairWorkerRef.current;
    if (!worker) return;
    const liveIds = new Set(models.map((model) => model.id));

    for (const id of analyzedMeshRef.current.keys()) {
      if (liveIds.has(id)) continue;
      analyzedMeshRef.current.delete(id);
      meshRepairGenerationRef.current.remove(id);
    }
    setMeshAnalysisByModel((previous) => Object.fromEntries(
      Object.entries(previous).filter(([id]) => liveIds.has(Number(id))),
    ));
    setActiveMeshIssue((active) => active && liveIds.has(active.modelId) ? active : null);

    for (const model of models) {
      if (analyzedMeshRef.current.get(model.id) === model.mesh) continue;
      analyzedMeshRef.current.set(model.id, model.mesh);
      const token = meshRepairGenerationRef.current.next(model.id);
      setMeshAnalysisByModel((previous) => ({
        ...previous,
        [model.id]: { status: "loading" },
      }));
      worker.postMessage({ ...token, mesh: model.mesh });
    }
  }, [models]);

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
    // React batchuje vícenásobný import; useEffect by se mezi soubory nestihl
    // propsat do refu a všechny modely by dostaly stejný slot [0,0].
    const currentModels = modelsRef.current;
    const slot = SLOT_OFFSETS[currentModels.length % SLOT_OFFSETS.length];
    const item: ModelItem = {
      id: nextId++,
      name,
      mesh: m,
      original: m,
      transform: { ...DEFAULT_TRANSFORM, x: slot[0], y: slot[1] },
    };
    const nextModels = [...currentModels, item];
    modelsRef.current = nextModels;
    setModels(nextModels);
    setSelectedId(item.id);
    invalidateSlice();
    showToast("ok", `Model přidán ✓ · ${name}`);
  }, [invalidateSlice]);

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

  const loadBenchy = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/models/3DBenchy.stl");
      if (!res.ok) throw new Error("3DBenchy.stl nenalezeno.");
      const mesh = parseStl(await res.arrayBuffer());
      addModel(mesh, "3DBenchy");
    } catch (e) {
      showToast("err", e instanceof Error ? e.message : "Nepodařilo se načíst Benchy.", 8000);
    } finally {
      setLoading(false);
    }
  }, [addModel]);

  const clearAll = useCallback(() => {
    modelsRef.current = [];
    setModels([]);
    setSelectedId(null);
    invalidateSlice();
    showToast("ok", "Vše smazáno");
  }, [invalidateSlice]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printerId, resinId, filmId, settings]);

  // Změna tiskárny mění rozlišení, proto musí invalidace proběhnout synchronně s volbou.
  const selectPrinter = useCallback((id: string) => {
    invalidateSlice();
    setPrinterId(id);
  }, [invalidateSlice]);

  const selectResin = useCallback(
    (id: string) => {
      setResinId(id);
      const r = getResin(id);
      const f = getFilm(filmId);
      updateSettings((s) => ({
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
      updateSettings((s) => ({
        ...s,
        normalExposure: Math.round(r.normalExposure * f.exposureFactor * 10) / 10,
      }));
    },
    [resinId]
  );

  const selected = models.find((m) => m.id === selectedId) ?? null;
  const selectedAnalysis = selectedId === null ? undefined : meshAnalysisByModel[selectedId];
  const selectedReport = selectedAnalysis?.status === "ready" ? selectedAnalysis.report : undefined;
  const selectedRepairPlan = selectedAnalysis?.status === "ready" ? selectedAnalysis.plan : undefined;
  const selectedIssueCount = selectedReport
    ? MESH_ISSUE_ROWS.reduce((sum, row) => sum + selectedReport[row.key].count, 0)
    : 0;
  const selectedRepairChangeCount = selectedRepairPlan
    ? selectedRepairPlan.removeDegenerateTriangles.length
      + selectedRepairPlan.removeDuplicateTriangles.length
      + selectedRepairPlan.flipTriangles.length
    : 0;
  const activeMeshDiagnostic = useMemo(() => {
    if (!activeMeshIssue || activeMeshIssue.modelId !== selectedId) return null;
    const entry = meshAnalysisByModel[activeMeshIssue.modelId];
    const group = entry?.report?.[activeMeshIssue.group] as MeshIssueGroup | undefined;
    const sample = group?.samples[activeMeshIssue.sampleIndex];
    return sample ? { modelId: activeMeshIssue.modelId, sample } : null;
  }, [activeMeshIssue, meshAnalysisByModel, selectedId]);

  const updateModel = useCallback((id: number, fn: (m: ModelItem) => ModelItem) => {
    setModels((prev) => {
      const next = prev.map((m) => (m.id === id ? fn(m) : m));
      modelsRef.current = next;
      return next;
    });
    invalidateSlice();
  }, [invalidateSlice]);

  const selectMeshIssue = useCallback((group: MeshIssueGroupKey) => {
    if (selectedId === null) return;
    const issueGroup = meshAnalysisByModel[selectedId]?.report?.[group] as MeshIssueGroup | undefined;
    if (!issueGroup?.samples.length) return;
    setActiveMeshIssue({ modelId: selectedId, group, sampleIndex: 0 });
  }, [selectedId, meshAnalysisByModel]);

  const cycleMeshIssue = useCallback((direction: -1 | 1) => {
    setActiveMeshIssue((active) => {
      if (!active) return null;
      const group = meshAnalysisByModel[active.modelId]?.report?.[active.group] as MeshIssueGroup | undefined;
      if (!group?.samples.length) return null;
      const sampleIndex = (active.sampleIndex + direction + group.samples.length) % group.samples.length;
      return { ...active, sampleIndex };
    });
  }, [meshAnalysisByModel]);

  const repairSelectedMesh = useCallback(() => {
    if (selectedId === null || !selected || !selectedRepairPlan) return;
    const plannedChanges = selectedRepairPlan.removeDegenerateTriangles.length
      + selectedRepairPlan.removeDuplicateTriangles.length
      + selectedRepairPlan.flipTriangles.length;
    if (plannedChanges === 0) {
      showToast("ok", "Model nemá bezpečně opravitelné vady.");
      return;
    }
    try {
      const result = applySafeMeshRepair(selected.mesh, selectedRepairPlan);
      updateModel(selectedId, (model) => applyRepairToModelState(model, result));
      setActiveMeshIssue(null);
      showToast(
        "ok",
        `Opraveno ✓ · odstraněno ${result.removedDegenerate} degenerovaných + ${result.removedDuplicates} duplicitních · otočeno ${result.flippedTriangles}`,
        9000,
      );
    } catch (error) {
      showToast("err", error instanceof Error ? error.message : "Bezpečná oprava selhala.", 9000);
    }
  }, [selectedId, selected, selectedRepairPlan, updateModel]);

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
    updateModel(selectedId, (m) => m.repairBackup
      ? restoreRepairBackup(m)
      : {
          ...m,
          mesh: m.original,
          transform: { ...DEFAULT_TRANSFORM },
        });
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
    setModels((prev) => {
      const next = prev.filter((m) => m.id !== selectedId);
      modelsRef.current = next;
      return next;
    });
    setSelectedId(null);
    invalidateSlice();
  }, [selectedId, invalidateSlice]);

  const removeModel = useCallback(
    (id: number) => {
      setModels((prev) => {
        const next = prev.filter((m) => m.id !== id);
        modelsRef.current = next;
        return next;
      });
      if (selectedId === id) setSelectedId(null);
      invalidateSlice();
    },
    [selectedId, invalidateSlice]
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
    setModels((prev) => {
      const next = [...prev, copy];
      modelsRef.current = next;
      return next;
    });
    setSelectedId(copy.id);
    invalidateSlice();
    showToast("ok", "Model duplikován ✓");
  }, [selectedId, models, invalidateSlice]);

  const splitSel = useCallback(() => {
    if (!selectedId) return;
    const item = models.find((model) => model.id === selectedId);
    if (!item) return;

    const shells = splitConnectedShells(item.mesh);
    if (shells.length <= 1) {
      showToast("ok", "Model tvoří jen jednu propojenou část.");
      return;
    }

    const canRestoreOriginal = item.original.triangleCount === item.mesh.triangleCount;
    const parts: ModelItem[] = shells.map((shell, index) => ({
      ...item,
      id: nextId++,
      name: `${item.name} — část ${index + 1}`,
      mesh: shell.mesh,
      original: canRestoreOriginal
        ? extractMeshTriangles(item.original, shell.triangleIndices)
        : shell.mesh,
      transform: { ...item.transform },
      repairBackup: undefined,
    }));

    setModels((previous) => {
      const next = previous.flatMap((model) => model.id === selectedId ? parts : [model]);
      modelsRef.current = next;
      return next;
    });
    setSelectedId(parts[0].id);
    invalidateSlice();
    showToast("ok", `Rozděleno na ${parts.length} propojených částí ✓`);
  }, [selectedId, models, invalidateSlice]);

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

function getSliceWorker(): Worker {
  if (!sliceWorkerRef.current) {
    sliceWorkerRef.current = new Worker(new URL("../lib/slice.worker.ts", import.meta.url));
  }
  return sliceWorkerRef.current;
}

function discardSliceWorker(worker: Worker) {
  if (sliceWorkerRef.current === worker) {
    worker.terminate();
    sliceWorkerRef.current = null;
  }
}

/** Náhledové PNG vygenerované na hlavním vlákně (canvas). */
async function genPreviewBytes(
  slice: SliceResult,
  layerIdx: number,
  w: number,
  h: number
): Promise<Uint8Array> {
  const layer = slice.layers[layerIdx];
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D není dostupné.");
  ctx.fillStyle = "#052636";
  ctx.fillRect(0, 0, w, h);
  const sx = w / slice.resolutionX;
  const sy = h / slice.resolutionY;
  const src = layer.data;
  for (let y = 0; y < slice.resolutionY; y++) {
    for (let x = 0; x < slice.resolutionX; x++) {
      const v = src[y * slice.resolutionX + x];
      if (v > 0) {
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(x * sx, y * sy, sx + 1, sy + 1);
      }
    }
  }
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob selhalo"))), "image/png")
  );
  return new Uint8Array(await blob.arrayBuffer());
}

/** Nativní full-res streaming export ve workeru. */
function exportFullInWorker(
  models: ModelItem[],
  settings: SliceSettings,
  printer: PrinterProfile,
  exposures: {
    bottomExposure: number;
    normalExposure: number;
    bottomLayers: number;
    zupHeightBottom: number;
    zupSpeedBottom: number;
    zupHeight: number;
    zupSpeed: number;
    printTimeS: number;
  },
  previews: [Uint8Array, Uint8Array],
  diagnostics: SliceDiagnostics | null,
  onProgress: (done: number, total: number) => void
): Promise<Uint8Array> {
  const worker = getSliceWorker();
  const id = ++sliceSeqRef.current;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener("message", handler);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
    };
    const onError = () => {
      cleanup();
      discardSliceWorker(worker);
      reject(new Error("Slicovací worker spadl během exportu."));
    };
    const onMessageError = () => {
      cleanup();
      discardSliceWorker(worker);
      reject(new Error("Worker vrátil nečitelná data exportu."));
    };
    const handler = (ev: MessageEvent<SliceWorkerResponse>) => {
      const msg = ev.data;
      if (msg.id !== id) return;
      if (msg.kind === "exportFull-progress") {
        if (typeof msg.done === "number" && typeof msg.total === "number") {
          onProgress(msg.done, msg.total);
        }
        return; // progress nezavírá handler
      }
      cleanup();
      if (msg.ok && msg.bytes) resolve(msg.bytes);
      else reject(new Error(msg.error ?? "Full-res export selhal."));
    };
    worker.addEventListener("message", handler);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
    worker.postMessage({
      id,
      kind: "exportFull",
      models: models.map((m) => ({
        positions: m.mesh.positions,
        bounds: m.mesh.bounds,
        triangleCount: m.mesh.triangleCount,
        tx: m.transform.x,
        ty: m.transform.y,
      })),
      settings: {
        layerHeight: settings.layerHeight,
        hollow: settings.hollow,
        wallMm: settings.wallMm,
        holeDiaMm: settings.holeDiaMm,
        drainHoles: settings.drainHoles,
        supports: settings.supports,
        supportRadiusMm: settings.supportRadiusMm,
        supportTipMm: settings.supportTipMm,
        supportMaxAngleDeg: settings.supportMaxAngleDeg,
        supportSpacingMm: settings.supportSpacingMm,
        supportClearanceMm: settings.supportClearanceMm,
        raft: settings.raft,
        raftLayers: settings.raftLayers,
        raftMarginMm: settings.raftMarginMm,
        raftRim: settings.raftRim,
        raftRimWidthMm: settings.raftRimWidthMm,
        raftRimHeightMm: settings.raftRimHeightMm,
        aa: false, // full-res: AA se nepoužívá (nativní pixely)
      } satisfies PipelineSettings,
      printer: {
        resX: printer.resX,
        resY: printer.resY,
        printX: printer.printX,
        printY: printer.printY,
      },
      exposures,
      previews,
      drainAnchors: diagnostics?.drainAnchors ?? [],
    });
  });
}

/**
 * Spustí slicování ve workeru. Vrstvy se přenesou přes transfer (bez kopie).
 * Pokud worker selže (CSP apod.), spadne na synchronní CPU pipeline (fallback).
 */
function sliceInWorker(
  models: ModelItem[],
  settings: SliceSettings,
  printer: PrinterProfile
): Promise<{
  result: SliceResult | null;
  supportPreview: SupportPreviewData | null;
  engine: "gpu" | "cpu";
  diagnostics: SliceDiagnostics;
}> {
  const payload = {
    id: ++sliceSeqRef.current,
    models: models.map((m) => ({
      positions: m.mesh.positions,
      bounds: m.mesh.bounds,
      triangleCount: m.mesh.triangleCount,
      tx: m.transform.x,
      ty: m.transform.y,
    })),
    settings: {
      layerHeight: settings.layerHeight,
      hollow: settings.hollow,
      wallMm: settings.wallMm,
      holeDiaMm: settings.holeDiaMm,
      drainHoles: settings.drainHoles,
      supports: settings.supports,
      supportRadiusMm: settings.supportRadiusMm,
      supportTipMm: settings.supportTipMm,
      supportMaxAngleDeg: settings.supportMaxAngleDeg,
      supportSpacingMm: settings.supportSpacingMm,
      supportClearanceMm: settings.supportClearanceMm,
      raft: settings.raft,
      raftLayers: settings.raftLayers,
      raftMarginMm: settings.raftMarginMm,
      raftRim: settings.raftRim,
      raftRimWidthMm: settings.raftRimWidthMm,
      raftRimHeightMm: settings.raftRimHeightMm,
      aa: settings.aa,
    } satisfies PipelineSettings,
    printer: {
      resX: printer.resX,
      resY: printer.resY,
      printX: printer.printX,
      printY: printer.printY,
    },
    forceCpu: !!(globalThis as any).__forceCpu,
  };

  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = getSliceWorker();
    } catch {
      // worker isn't available → synchronous fallback on main thread
      try {
        resolve(runSlicePipeline(payload.models, payload.settings, payload.printer));
      } catch (e) {
        reject(e);
      }
      return;
    }

    const handler = (ev: MessageEvent<SliceWorkerResponse>) => {
      const msg = ev.data;
      if (msg.id !== payload.id) return;
      cleanup();
      if (msg.ok && msg.result) {
        resolve({
          result: msg.result,
          supportPreview: msg.supportPreview ?? null,
          engine: msg.engine ?? "cpu",
          diagnostics: msg.diagnostics ?? { islandCount: 0, islands: [], truncated: false, drainAnchors: [] },
        });
      } else {
        reject(new Error(msg.error ?? "Slicování selhalo."));
      }
    };

    const cleanup = () => {
      worker.removeEventListener("message", handler);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
    };
    const onError = () => {
      cleanup();
      discardSliceWorker(worker);
      runSlicePipeline(payload.models, payload.settings, payload.printer, { forceCpu: true })
        .then(resolve, reject);
    };
    const onMessageError = () => {
      cleanup();
      discardSliceWorker(worker);
      reject(new Error("Worker vrátil nečitelná data slicování."));
    };

    worker.addEventListener("message", handler);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
    worker.postMessage(payload);
  });
}

const doSlice = useCallback(async () => {
  if (models.length === 0) return;
  invalidateSlice();
  const generation = sliceGenerationRef.current.startRequest();
  setSlicing(true);
  try {
    const { result, supportPreview: sp, engine, diagnostics } = await sliceInWorker(models, settings, printer);
    if (!sliceGenerationRef.current.isCurrent(generation)) return;
    if (result) {
      setSliceResult(result);
      setSupportPreview(sp);
      setSliceDiagnostics(diagnostics);
      // začni od horní vrstvy → model je v 3D vidět celý, tahem slideru dolů vidíš řez
      setSliceIdx(Math.max(0, result.layers.length - 1));
      if (typeof window !== "undefined") {
        // debug hook pro headless testy (hash + pixelové počty vzorků pro porovnání GPU/CPU)
        const fnv = (a: Uint8Array, h: number) => {
          for (let i = 0; i < a.length; i++) h = ((h ^ a[i]) * 16777619) >>> 0;
          return h;
        };
        const countPx = (a: Uint8Array) => {
          let c = 0;
          for (let i = 0; i < a.length; i++) c += a[i] ? 1 : 0;
          return c;
        };
        let h = 2166136261 >>> 0;
        const n = result.layers.length;
        const idxs = [0, Math.floor(n / 2), n - 1];
        const samples: number[] = [];
        for (const idx of idxs) {
          if (idx >= 0 && idx < n) {
            h = fnv(result.layers[idx].data, h);
            samples.push(countPx(result.layers[idx].data));
          }
        }
        (window as any).__lastSlice = {
          engine,
          layers: n,
          resX: result.resolutionX,
          resY: result.resolutionY,
          hash: h,
          samples,
        };
      }
      // Náhled nesmí používat 1/16 pracovní raster. Vygenerujeme stejná nativní
      // PW0 data, která půjdou do tiskárny, a slider dekóduje přímo vybranou vrstvu.
      const previewPngs = await Promise.all([
        genPreviewBytes(result, 0, 224, 168),
        genPreviewBytes(result, Math.floor(result.layers.length / 2), 224, 168),
      ]);
      if (!sliceGenerationRef.current.isCurrent(generation)) return;
      const perLayer = settings.normalExposure +
        2 * (settings.zupHeight / Math.max(settings.zupSpeed, 0.1)) + 2;
      const bottomTime = settings.bottomLayers * (
        settings.bottomExposure +
        2 * (settings.zupHeightBottom / Math.max(settings.zupSpeedBottom, 0.1)) + 2
      );
      const printTimeS = Math.round(
        bottomTime + Math.max(0, result.layers.length - settings.bottomLayers) * perLayer
      );
      setExportProgress("připravuji geometrii…");
      const bytes = await exportFullInWorker(models, settings, printer, {
        bottomExposure: settings.bottomExposure,
        normalExposure: settings.normalExposure,
        bottomLayers: settings.bottomLayers,
        zupHeightBottom: settings.zupHeightBottom,
        zupSpeedBottom: settings.zupSpeedBottom,
        zupHeight: settings.zupHeight,
        zupSpeed: settings.zupSpeed,
        printTimeS,
      }, previewPngs, diagnostics, (done, total) => {
        if (sliceGenerationRef.current.isCurrent(generation)) setExportProgress(`${done}/${total}`);
      });
      if (!sliceGenerationRef.current.isCurrent(generation)) return;
      const archive = openPm7PreviewArchive(bytes, printer.resX, printer.resY);
      if (archive.layerCount !== result.layers.length) {
        throw new Error(
          `Přesný náhled má ${archive.layerCount} vrstev, pracovní řez ${result.layers.length}.`
        );
      }
      setExactPreview(archive);
      setLastExport({ bytes, name: `${exportName}.${printer.keySuffix}` });
      setExportProgress(null);
      showToast(
        "ok",
        `Naslicováno přesně ✓ · ${result.layers.length} vrstev · nativně ${printer.resX}×${printer.resY}${settings.supports ? " · podpory" : ""}${diagnostics.islandCount ? ` · ${diagnostics.islandCount} islandů` : " · bez islandů"}`
      );
    }
  } catch (e) {
    if (sliceGenerationRef.current.isCurrent(generation)) {
      setSliceResult(null);
      setExactPreview(null);
      setSupportPreview(null);
      setSliceDiagnostics(null);
      setLastExport(null);
      setExportProgress(null);
      showToast("err", e instanceof Error ? e.message : "Slicování selhalo.", 8000);
    }
  } finally {
    if (sliceGenerationRef.current.isCurrent(generation)) setSlicing(false);
  }
}, [models, settings, printer, exportName, invalidateSlice]);

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

  const buildExport = useCallback(async (
    sliceOverride?: SliceResult,
    diagnosticsOverride?: SliceDiagnostics,
    generation = sliceGenerationRef.current.capture(),
  ): Promise<{ bytes: Uint8Array; name: string } | null> => {
    if (!sliceGenerationRef.current.isCurrent(generation)) return null;
    if (printer.exportSupported === false) {
      throw new Error(`${printer.name}: tiskový formát .${printer.keySuffix} zatím není podporovaný.`);
    }
    const activeSlice = sliceOverride ?? sliceResult;
    const activeDiagnostics = diagnosticsOverride ?? sliceDiagnostics;
    if (!activeSlice || models.length === 0) return null;
    if (!sliceOverride && lastExport) {
      return { bytes: lastExport.bytes, name: `${exportName}.${printer.keySuffix}` };
    }
    const activePrintTime = sliceOverride
      ? Math.round(
          settings.bottomLayers *
            (settings.bottomExposure +
              2 * (settings.zupHeightBottom / Math.max(settings.zupSpeedBottom, 0.1)) +
              2) +
          Math.max(0, activeSlice.layers.length - settings.bottomLayers) *
            (settings.normalExposure +
              2 * (settings.zupHeight / Math.max(settings.zupSpeed, 0.1)) +
              2)
        )
      : estPrintTime;
    // náhledová PNG (generuje hlavní vlákno z canvasu)
    const previews = await Promise.all([
      genPreviewBytes(activeSlice, 0, 224, 168),
      genPreviewBytes(
        activeSlice,
        Math.min(activeSlice.layers.length - 1, Math.max(0, Math.floor(activeSlice.layers.length / 2))),
        224,
        168
      ),
    ]);
    if (!sliceGenerationRef.current.isCurrent(generation)) return null;
    // export VŽDY v nativním rozlišení tiskárny (full-res streaming ve workeru)
    try {
      const bytes = await exportFullInWorker(models, settings, printer, {
        bottomExposure: settings.bottomExposure,
        normalExposure: settings.normalExposure,
        bottomLayers: settings.bottomLayers,
        zupHeightBottom: settings.zupHeightBottom,
        zupSpeedBottom: settings.zupSpeedBottom,
        zupHeight: settings.zupHeight,
        zupSpeed: settings.zupSpeed,
        printTimeS: activePrintTime,
      }, previews, activeDiagnostics, (done, total) => {
        if (sliceGenerationRef.current.isCurrent(generation)) {
          setExportProgress(`${done}/${total}`);
        }
      });
      if (!sliceGenerationRef.current.isCurrent(generation)) return null;
      setExportProgress(null);
      return { bytes, name: `${exportName}.${printer.keySuffix}` };
    } catch (e) {
      if (!sliceGenerationRef.current.isCurrent(generation)) return null;
      setExportProgress(null);
      showToast("err", "Full-res export selhal → záložně v náhledovém rozlišení.", 6000);
      const bytes = await buildPm7(
        models.map((m) => applyTransform(m.mesh, m.transform)),
        activeSlice,
        {
          printer,
          bottomExposure: settings.bottomExposure,
          normalExposure: settings.normalExposure,
          bottomLayers: settings.bottomLayers,
          zupHeight: settings.zupHeight,
          zupSpeed: settings.zupSpeed,
          zupHeightBottom: settings.zupHeightBottom,
          zupSpeedBottom: settings.zupSpeedBottom,
          printTimeS: activePrintTime,
        }
      );
      if (!sliceGenerationRef.current.isCurrent(generation)) return null;
      return { bytes, name: `${exportName}.${printer.keySuffix}` };
    }
  }, [sliceResult, models, settings, printer, exportName, estPrintTime, sliceDiagnostics, lastExport]);

  const exportPm7 = useCallback(async () => {
    const generation = sliceGenerationRef.current.capture();
    setExporting(true);
    try {
      const ex = await buildExport(undefined, undefined, generation);
      if (!sliceGenerationRef.current.isCurrent(generation)) return;
      if (!ex) return;
      downloadBytes(ex.bytes, ex.name);
      setLastExport(ex);
      showToast("ok", "Soubor .pm7 stažen ✓ · USB: kořen disku, ≤15 znaků, FAT32", 10000);
    } catch (e) {
      if (sliceGenerationRef.current.isCurrent(generation)) {
        showToast("err", e instanceof Error ? e.message : "Export .pm7 selhal.", 8000);
      }
    } finally {
      if (sliceGenerationRef.current.isCurrent(generation)) setExporting(false);
    }
  }, [buildExport]);

  const printNow = useCallback(async () => {
    if (models.length === 0) return;
    let generation: number;
    if (sliceResult) {
      generation = sliceGenerationRef.current.capture();
    } else {
      invalidateSlice();
      generation = sliceGenerationRef.current.startRequest();
    }
    setSending(true);
    try {
      // 1) slicovat, pokud ještě není
      let activeSlice = sliceResult;
      let activeDiagnostics = sliceDiagnostics;
      if (!activeSlice) {
        showToast("ok", "Slicuji…", 3000);
        const { result, supportPreview: sp, diagnostics } = await sliceInWorker(models, settings, printer);
        if (!sliceGenerationRef.current.isCurrent(generation)) return;
        if (!result) {
          showToast("err", "Slicování selhalo.", 8000);
          return;
        }
        setSupportPreview(sp);
        setSliceResult(result);
        setSliceDiagnostics(diagnostics);
        setSliceIdx(0);
        activeSlice = result;
        activeDiagnostics = diagnostics;
      }
      // 2) připravit soubor v paměti (bez stažení)
      const ex = await buildExport(activeSlice, activeDiagnostics ?? undefined, generation);
      if (!sliceGenerationRef.current.isCurrent(generation)) return;
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
      if (!sliceGenerationRef.current.isCurrent(generation)) return;
      // 4) poslat do tiskárny
      const fileId = await sendPrintToPrinter(ex.bytes, ex.name, jwt, (msg) => {
        if (sliceGenerationRef.current.isCurrent(generation)) showToast("ok", msg, 6000);
      });
      if (sliceGenerationRef.current.isCurrent(generation)) {
        showToast(
          "ok",
          `Soubor poslán do tiskárny ✓ (file ${fileId}) · tiskárna stahuje · tisk potvrď na displeji tiskárny`,
          15000
        );
      }
    } catch (e) {
      if (sliceGenerationRef.current.isCurrent(generation)) {
        showToast("err", e instanceof Error ? e.message : "Odeslání do tiskárny selhalo.", 10000);
      }
    } finally {
      if (sliceGenerationRef.current.isCurrent(generation)) setSending(false);
    }
  }, [models, sliceResult, sliceDiagnostics, settings, printer, buildExport, invalidateSlice]);

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
    setModels((prev) => {
      const next = prev.map((m, i) => {
        const s = SLOT_OFFSETS[i % SLOT_OFFSETS.length];
        return { ...m, transform: { ...m.transform, x: s[0], y: s[1] } };
      });
      modelsRef.current = next;
      return next;
    });
    invalidateSlice();
    showToast("ok", "Modely rozmístěny ✓");
  }, [invalidateSlice]);

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


  const volMl = useMemo(
    () => totalVolume(models.map((m) => applyTransform(m.mesh, m.transform))) / 1000,
    [models]
  );
  const selStats: MeshStats | null = useMemo(
    () => selected ? meshStats(selected.mesh) : null,
    [selected]
  );

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
  const sliceReady = !!sliceResult && !!exactPreview && !!lastExport;

  const layerPreview = useMemo(
    () => buildNativeLayerPreview(sliceResult, exactPreview, sliceIdx),
    [sliceResult, exactPreview, sliceIdx]
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
        invalidateSlice();
      } else if (e.key === "Delete" && selectedId !== null) {
        removeModel(selectedId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [orientSel, doSlice, exportPm7, duplicateSel, centerSel, resetSel, printNow, mirrorSel, nudgeSel, sliceResult, removeModel, invalidateSlice]);

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
          <button className="btn btn-small btn-ghost" onClick={loadBenchy}>
            Benchy
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
            supportPreview={supportPreview}
            meshDiagnostic={activeMeshDiagnostic}
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
              <button className="mp-btn" onClick={splitSel}>Rozdělit části</button>
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
            label="Kontrola modelu"
            open={openSec === "repair"}
            onToggle={() => setOpenSec(openSec === "repair" ? "" : "repair")}
          >
            {!selected && <p className="mp-hint">Vyber model pro automatickou kontrolu.</p>}
            {selected && selectedAnalysis?.status === "loading" && (
              <p className="mesh-repair-status">Analyzuji topologii mimo hlavní vlákno…</p>
            )}
            {selected && selectedAnalysis?.status === "error" && (
              <p className="mesh-repair-status bad">⚠ {selectedAnalysis.error}</p>
            )}
            {selected && selectedReport && selectedIssueCount === 0 && (
              <p className="mesh-repair-status good">✓ Bez zjištěných topologických vad</p>
            )}
            {selected && selectedReport && selectedIssueCount > 0 && (
              <>
                <p className="mesh-repair-status bad">
                  ⚠ Nalezeno {selectedIssueCount} problémů · {selectedReport.shellCount} částí
                </p>
                <div className="mesh-issue-list">
                  {MESH_ISSUE_ROWS.map((row) => {
                    const group = selectedReport[row.key];
                    if (group.count === 0) return null;
                    const active = activeMeshIssue?.modelId === selected.id
                      && activeMeshIssue.group === row.key;
                    return (
                      <button
                        key={row.key}
                        className={`mesh-issue-row ${active ? "active" : ""}`}
                        onClick={() => selectMeshIssue(row.key)}
                        title="Zvýraznit nález červeně ve 3D"
                      >
                        <span>{row.repairable ? "🔧" : "⚠"} {row.label}</span>
                        <b>{group.count}</b>
                      </button>
                    );
                  })}
                </div>
                {activeMeshIssue?.modelId === selected.id && (
                  <div className="mesh-issue-nav">
                    <button className="mp-btn" onClick={() => cycleMeshIssue(-1)}>←</button>
                    <span>
                      Nález {activeMeshIssue.sampleIndex + 1} / {
                        (selectedReport[activeMeshIssue.group] as MeshIssueGroup).samples.length
                      }
                    </span>
                    <button className="mp-btn" onClick={() => cycleMeshIssue(1)}>→</button>
                    <button className="mp-btn" onClick={() => setActiveMeshIssue(null)}>Skrýt</button>
                  </div>
                )}
                {selectedRepairPlan && (
                  <div className="mesh-repair-plan">
                    Bezpečný plán: odstranit {selectedRepairPlan.removeDegenerateTriangles.length} degenerovaných
                    {" + "}{selectedRepairPlan.removeDuplicateTriangles.length} duplicitních · otočit {selectedRepairPlan.flipTriangles.length} ploch
                    {selectedRepairPlan.unresolvedWindingComponents > 0
                      ? ` · ${selectedRepairPlan.unresolvedWindingComponents} konfliktů zůstane označeno`
                      : ""}
                  </div>
                )}
                <button
                  className="btn btn-small btn-primary mesh-repair-button"
                  disabled={selectedRepairChangeCount === 0}
                  onClick={repairSelectedMesh}
                >
                  Bezpečně opravit
                </button>
                <p className="mp-hint">
                  Díry, non-manifold hrany a malé části se pouze označí — automaticky se nemažou ani nezavírají.
                </p>
              </>
            )}
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
                onChange={(e) => updateSettings((s) => ({ ...s, supports: e.target.checked }))}
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
                    onChange={(e) => updateSettings((s) => ({ ...s, supportRadiusMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Špička (mm)</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0.2}
                    value={settings.supportTipMm}
                    onChange={(e) => updateSettings((s) => ({ ...s, supportTipMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Max úhel podhledu (°)</span>
                  <input
                    type="number"
                    step={5}
                    min={10}
                    max={80}
                    value={settings.supportMaxAngleDeg}
                    onChange={(e) => updateSettings((s) => ({ ...s, supportMaxAngleDeg: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Rozestup (mm)</span>
                  <input
                    type="number"
                    step={1}
                    min={3}
                    max={20}
                    value={settings.supportSpacingMm}
                    onChange={(e) => updateSettings((s) => ({ ...s, supportSpacingMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Min. výška od desky (mm)</span>
                  <input
                    type="number"
                    step={0.5}
                    min={0}
                    max={5}
                    value={settings.supportClearanceMm}
                    onChange={(e) => updateSettings((s) => ({ ...s, supportClearanceMm: Number(e.target.value) }))}
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
                onChange={(e) => updateSettings((s) => ({ ...s, hollow: e.target.checked }))}
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
                    onChange={(e) => updateSettings((s) => ({ ...s, wallMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Otvory Ø (mm)</span>
                  <input
                    type="number"
                    step={0.5}
                    min={1}
                    value={settings.holeDiaMm}
                    onChange={(e) => updateSettings((s) => ({ ...s, holeDiaMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row check">
                  <input
                    type="checkbox"
                    checked={settings.drainHoles}
                    onChange={(e) => updateSettings((s) => ({ ...s, drainHoles: e.target.checked }))}
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
                onChange={(e) => updateSettings((s) => ({ ...s, raft: e.target.checked }))}
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
                    onChange={(e) => updateSettings((s) => ({ ...s, raftLayers: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Přesah (mm)</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={settings.raftMarginMm}
                    onChange={(e) => updateSettings((s) => ({ ...s, raftMarginMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row check">
                  <input
                    type="checkbox"
                    checked={settings.raftRim}
                    onChange={(e) => updateSettings((s) => ({ ...s, raftRim: e.target.checked }))}
                  />
                  <span>Rantlík pro špachtli</span>
                </label>
                {settings.raftRim && (
                  <>
                    <label className="set-row">
                      <span>Šířka rantlíku (mm)</span>
                      <input
                        type="number"
                        min={0.5}
                        max={5}
                        step={0.1}
                        value={settings.raftRimWidthMm}
                        onChange={(e) => updateSettings((s) => ({ ...s, raftRimWidthMm: Number(e.target.value) }))}
                      />
                    </label>
                    <label className="set-row">
                      <span>Výška rantlíku (mm)</span>
                      <input
                        type="number"
                        min={0.1}
                        max={2}
                        step={0.1}
                        value={settings.raftRimHeightMm}
                        onChange={(e) => updateSettings((s) => ({ ...s, raftRimHeightMm: Number(e.target.value) }))}
                      />
                    </label>
                  </>
                )}
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
              onClick={sliceReady ? printNow : doSlice}
              disabled={sending || exporting || slicing}
            >
              {sending
                ? "Posílám…"
                : slicing
                ? "Připravuji vrstvy…"
                : sliceReady
                ? "Tisknout"
                : "Slicovat"}
            </button>
            <button
              className="btn btn-small btn-ghost fab-usb"
              onClick={exportPm7}
              disabled={exporting || slicing || !sliceReady}
              title={`Uložit soubor na USB (stažení .pm7 v nativním ${printer.resX}×${printer.resY})`}
            >
              {exporting ? "…" : "USB"}
            </button>
            {exportProgress && (
              <div className="fab-progress">Nativní vrstvy {exportProgress}</div>
            )}
          </div>
        )}

        {showSettings && (
          <div className="info-panel settings">
            <div className="info-title">Nastavení tisku</div>
            <label className="set-row">
              <span>Tiskárna</span>
              <select
                value={printerId}
                onChange={(e) => selectPrinter(e.target.value)}
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
                onChange={(e) => updateSettings((s) => ({ ...s, layerHeight: Number(e.target.value) }))}
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
                onChange={(e) => updateSettings((s) => ({ ...s, bottomLayers: Number(e.target.value) }))}
              />
            </label>
            <label className="set-row">
              <span>Expozice 1. vrstev (s)</span>
              <input
                type="number"
                min={1}
                step={0.5}
                value={settings.bottomExposure}
                onChange={(e) => updateSettings((s) => ({ ...s, bottomExposure: Number(e.target.value) }))}
              />
            </label>
            <label className="set-row">
              <span>Expozice běžná (s)</span>
              <input
                type="number"
                min={0.5}
                step={0.1}
                value={settings.normalExposure}
                onChange={(e) => updateSettings((s) => ({ ...s, normalExposure: Number(e.target.value) }))}
              />
            </label>
            </details>
            <details>
              <summary>Podpory a kvalita</summary>
            <label className="set-row check">
              <input
                type="checkbox"
                checked={settings.supports}
                onChange={(e) => updateSettings((s) => ({ ...s, supports: e.target.checked }))}
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
                    onChange={(e) => updateSettings((s) => ({ ...s, supportRadiusMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Špička podpory (mm)</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0.2}
                    value={settings.supportTipMm}
                    onChange={(e) => updateSettings((s) => ({ ...s, supportTipMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Max úhel podhledu (°)</span>
                  <input
                    type="number"
                    step={5}
                    min={10}
                    max={80}
                    value={settings.supportMaxAngleDeg}
                    onChange={(e) => updateSettings((s) => ({ ...s, supportMaxAngleDeg: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Rozestup (mm)</span>
                  <input
                    type="number"
                    step={1}
                    min={3}
                    max={20}
                    value={settings.supportSpacingMm}
                    onChange={(e) => updateSettings((s) => ({ ...s, supportSpacingMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Min. výška od desky (mm)</span>
                  <input
                    type="number"
                    step={0.5}
                    min={0}
                    max={5}
                    value={settings.supportClearanceMm}
                    onChange={(e) => updateSettings((s) => ({ ...s, supportClearanceMm: Number(e.target.value) }))}
                  />
                </label>
              </>
            )}
            <label className="set-row check">
              <input
                type="checkbox"
                checked={settings.aa}
                onChange={(e) => updateSettings((s) => ({ ...s, aa: e.target.checked }))}
              />
            </label>
            </details>
            <details>
              <summary>Hollowing</summary>
            <label className="set-row check">
              <input
                type="checkbox"
                checked={settings.hollow}
                onChange={(e) => updateSettings((s) => ({ ...s, hollow: e.target.checked }))}
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
                    onChange={(e) => updateSettings((s) => ({ ...s, wallMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Otvory Ø (mm)</span>
                  <input
                    type="number"
                    step={0.5}
                    min={1}
                    value={settings.holeDiaMm}
                    onChange={(e) => updateSettings((s) => ({ ...s, holeDiaMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row check">
                  <input
                    type="checkbox"
                    checked={settings.drainHoles}
                    onChange={(e) => updateSettings((s) => ({ ...s, drainHoles: e.target.checked }))}
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
                onChange={(e) => updateSettings((s) => ({ ...s, raft: e.target.checked }))}
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
                    onChange={(e) => updateSettings((s) => ({ ...s, raftLayers: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row">
                  <span>Raft přesah (mm)</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={settings.raftMarginMm}
                    onChange={(e) => updateSettings((s) => ({ ...s, raftMarginMm: Number(e.target.value) }))}
                  />
                </label>
                <label className="set-row check">
                  <input
                    type="checkbox"
                    checked={settings.raftRim}
                    onChange={(e) => updateSettings((s) => ({ ...s, raftRim: e.target.checked }))}
                  />
                  <span>Rantlík pro špachtli</span>
                </label>
                {settings.raftRim && (
                  <>
                    <label className="set-row">
                      <span>Šířka rantlíku (mm)</span>
                      <input
                        type="number"
                        min={0.5}
                        max={5}
                        step={0.1}
                        value={settings.raftRimWidthMm}
                        onChange={(e) => updateSettings((s) => ({ ...s, raftRimWidthMm: Number(e.target.value) }))}
                      />
                    </label>
                    <label className="set-row">
                      <span>Výška rantlíku (mm)</span>
                      <input
                        type="number"
                        min={0.1}
                        max={2}
                        step={0.1}
                        value={settings.raftRimHeightMm}
                        onChange={(e) => updateSettings((s) => ({ ...s, raftRimHeightMm: Number(e.target.value) }))}
                      />
                    </label>
                  </>
                )}
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
                onChange={(e) => updateSettings((s) => ({ ...s, zupHeight: Number(e.target.value) }))}
              />
            </label>
            <label className="set-row">
              <span>Rychlost zvedání</span>
              <input
                type="number"
                step={0.5}
                min={0.5}
                value={settings.zupSpeed}
                onChange={(e) => updateSettings((s) => ({ ...s, zupSpeed: Number(e.target.value) }))}
              />
            </label>
            <label className="set-row">
              <span>Zvednutí 1. vrstev</span>
              <input
                type="number"
                step={0.1}
                min={0.1}
                value={settings.zupHeightBottom}
                onChange={(e) => updateSettings((s) => ({ ...s, zupHeightBottom: Number(e.target.value) }))}
              />
            </label>
            <label className="set-row">
              <span>Rychlost 1. vrstev</span>
              <input
                type="number"
                step={0.1}
                min={0.1}
                value={settings.zupSpeedBottom}
                onChange={(e) => updateSettings((s) => ({ ...s, zupSpeedBottom: Number(e.target.value) }))}
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
                <div className="info-row">
                  <span>Islands</span>
                  <b className={sliceDiagnostics?.islandCount ? "fit-bad" : ""}>
                    {sliceDiagnostics?.islandCount
                      ? `⚠ ${sliceDiagnostics.islandCount}${sliceDiagnostics.truncated ? "+" : ""}`
                      : "✓ žádné"}
                  </b>
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
                onClick={invalidateSlice}
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
            {sliceDiagnostics?.islandCount ? (
              <button
                type="button"
                className="btn btn-small btn-ghost"
                style={{ marginTop: 8, width: "100%" }}
                onClick={() => {
                  const next = sliceDiagnostics.islands.find((item) => item.layer > sliceIdx)
                    ?? sliceDiagnostics.islands[0];
                  if (next) setSliceIdx(next.layer);
                }}
              >
                ⚠ Přejít na další island ({sliceDiagnostics.islandCount})
              </button>
            ) : null}
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
