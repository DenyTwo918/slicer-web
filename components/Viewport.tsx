"use client";

import { Canvas, useThree } from "@react-three/fiber";
import {
  OrbitControls,
  Grid,
  TransformControls,
  Edges,
  Environment,
  ContactShadows,
} from "@react-three/drei";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { StlMesh } from "@/lib/stl";
import type { ModelTransform } from "@/lib/transform";
import type { PrinterProfile } from "@/lib/profiles";
import type { SupportPreviewData } from "@/lib/supports";

interface ViewModel {
  id: number;
  mesh: StlMesh;
  transform: ModelTransform;
  fits: boolean;
}

export interface LayerPreviewData {
  z: number;
  data: Uint8Array;
  resX: number;
  resY: number;
  layerHeight: number;
}

type PreviewSegment = {
  a: [number, number, number];
  b: [number, number, number];
  radius: number;
};

/** Hladké instancované válce/komolé kužely mezi libovolnými dvěma body. */
function SegmentInstances({
  segments,
  geometry,
  clippingPlane,
  color,
}: {
  segments: PreviewSegment[];
  geometry: THREE.BufferGeometry;
  clippingPlane: THREE.Plane;
  color: string;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    const up = new THREE.Vector3(0, 1, 0);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const dir = new THREE.Vector3();
    segments.forEach((s, i) => {
      a.fromArray(s.a);
      b.fromArray(s.b);
      dir.subVectors(b, a);
      const length = Math.max(0.0001, dir.length());
      dummy.position.copy(a).add(b).multiplyScalar(0.5);
      dummy.quaternion.setFromUnitVectors(up, dir.normalize());
      dummy.scale.set(s.radius, length, s.radius);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.count = segments.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [segments]);

  if (segments.length === 0) return null;
  return (
    <instancedMesh ref={ref} args={[geometry, undefined, segments.length]} frustumCulled={false}>
      <meshStandardMaterial
        color={color}
        metalness={0.05}
        roughness={0.5}
        clippingPlanes={[clippingPlane]}
        depthWrite
        depthTest
      />
    </instancedMesh>
  );
}

function TipInstances({
  tips,
  geometry,
  clippingPlane,
}: {
  tips: { p: [number, number, number]; radius: number }[];
  geometry: THREE.BufferGeometry;
  clippingPlane: THREE.Plane;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    tips.forEach((tip, i) => {
      dummy.position.fromArray(tip.p);
      dummy.quaternion.identity();
      dummy.scale.setScalar(tip.radius);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.count = tips.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [tips]);

  if (tips.length === 0) return null;
  return (
    <instancedMesh ref={ref} args={[geometry, undefined, tips.length]} frustumCulled={false}>
      <meshStandardMaterial
        color="#4ade80"
        metalness={0.04}
        roughness={0.42}
        clippingPlanes={[clippingPlane]}
        depthWrite
        depthTest
      />
    </instancedMesh>
  );
}

type Point2 = { x: number; y: number };

function rdp(points: Point2[], tolerance: number): Point2[] {
  if (points.length <= 2) return points;
  const a = points[0];
  const b = points[points.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denom = dx * dx + dy * dy;
  let best = -1;
  let bestDist = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const t = denom > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / denom)) : 0;
    const ex = p.x - (a.x + t * dx);
    const ey = p.y - (a.y + t * dy);
    const d = Math.hypot(ex, ey);
    if (d > bestDist) {
      bestDist = d;
      best = i;
    }
  }
  if (best < 0 || bestDist <= tolerance) return [a, b];
  const left = rdp(points.slice(0, best + 1), tolerance);
  const right = rdp(points.slice(best), tolerance);
  return [...left.slice(0, -1), ...right];
}

function simplifyClosed(points: Point2[], tolerance: number): Point2[] {
  if (points.length < 6) return points;
  let minI = 0;
  let maxI = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].x < points[minI].x) minI = i;
    if (points[i].x > points[maxI].x) maxI = i;
  }
  if (minI === maxI) return points;
  const path = (from: number, to: number) => {
    const out: Point2[] = [];
    for (let i = from; ; i = (i + 1) % points.length) {
      out.push(points[i]);
      if (i === to) break;
    }
    return out;
  };
  const a = rdp(path(minI, maxI), tolerance);
  const b = rdp(path(maxI, minI), tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Jedno Chaikinovo kolo zakulatí hrany bez návratu k pixelovým schodům. */
function smoothClosed(points: Point2[]): Point2[] {
  if (points.length < 3) return points;
  const out: Point2[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
    out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
  }
  return out;
}

/**
 * Vektorizuje obrys binární raft masky. Raster zůstává zdrojem pravdy pro tisk,
 * ale viewport dostane zjednodušený hladký polygon místo pixelové textury.
 */
function raftShapes(
  mask: Uint8Array,
  width: number,
  height: number,
  printer: PrinterProfile
): THREE.Shape[] {
  const outgoing = new Map<string, Point2[]>();
  const edges: { a: Point2; b: Point2 }[] = [];
  const key = (p: Point2) => `${p.x},${p.y}`;
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] !== 0;
  const add = (a: Point2, b: Point2) => {
    edges.push({ a, b });
    const list = outgoing.get(key(a));
    if (list) list.push(b);
    else outgoing.set(key(a), [b]);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) add({ x, y }, { x: x + 1, y });
      if (!on(x + 1, y)) add({ x: x + 1, y }, { x: x + 1, y: y + 1 });
      if (!on(x, y + 1)) add({ x: x + 1, y: y + 1 }, { x, y: y + 1 });
      if (!on(x - 1, y)) add({ x, y: y + 1 }, { x, y });
    }
  }

  const used = new Set<string>();
  const edgeKey = (a: Point2, b: Point2) => `${key(a)}>${key(b)}`;
  const loops: Point2[][] = [];
  for (const edge of edges) {
    if (used.has(edgeKey(edge.a, edge.b))) continue;
    const loop: Point2[] = [edge.a];
    let current = edge.a;
    let next = edge.b;
    for (let guard = 0; guard <= edges.length; guard++) {
      used.add(edgeKey(current, next));
      current = next;
      if (key(current) === key(loop[0])) break;
      loop.push(current);
      const candidates = outgoing.get(key(current)) ?? [];
      const candidate = candidates.find((p) => !used.has(edgeKey(current, p)));
      if (!candidate) break;
      next = candidate;
    }
    if (loop.length >= 3 && key(current) === key(loop[0])) loops.push(loop);
  }

  const sx = printer.printX / width;
  const sy = printer.printY / height;
  const tolerancePx = Math.max(1, 0.65 / Math.min(sx, sy));
  const shapes: THREE.Shape[] = [];
  for (const loop of loops) {
    // Drobná vnitřní oka nejsou samostatné rafty. Raft je plná základna.
    let area = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      area += a.x * b.y - b.x * a.y;
    }
    // Vnější obrysy mají při výše použité orientaci kladnou plochu; záporné
    // smyčky jsou vnitřní díry. Raft má být plný, proto je nepřidáváme jako
    // další překrývající se mesh (ten by blikáním vypadal rozbitě).
    if (area < 4) continue;
    const smooth = smoothClosed(simplifyClosed(loop, tolerancePx));
    if (smooth.length < 3) continue;
    const shape = new THREE.Shape();
    smooth.forEach((p, i) => {
      const wx = p.x * sx - printer.printX / 2;
      const wy = printer.printY / 2 - p.y * sy;
      if (i === 0) shape.moveTo(wx, wy);
      else shape.lineTo(wx, wy);
    });
    shape.closePath();
    shapes.push(shape);
  }
  return shapes;
}

/** Raft jako skutečný vektorový extrudovaný mesh, nikoli pixelová textura. */
function RaftPreview({
  preview,
  printer,
  cutZ,
}: {
  preview: SupportPreviewData;
  printer: PrinterProfile;
  cutZ: number;
}) {
  const height = Math.max(
    preview.layerHeight,
    (preview.raftLayers ?? 1) * preview.layerHeight
  );
  const geometry = useMemo(() => {
    const mask = preview.raftMask;
    if (!mask || mask.length === 0) return null;
    const shapes = raftShapes(
      mask,
      preview.resolutionX,
      preview.resolutionY,
      printer
    );
    if (shapes.length === 0) return null;
    return new THREE.ExtrudeGeometry(shapes, {
      depth: height,
      bevelEnabled: true,
      bevelSegments: 2,
      bevelSize: Math.min(0.35, height * 0.3),
      bevelThickness: Math.min(0.2, height * 0.2),
      curveSegments: 4,
    });
  }, [preview, printer, height]);
  const clippingPlane = useMemo(
    () => new THREE.Plane(new THREE.Vector3(0, 0, -1), cutZ),
    [cutZ]
  );
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry || cutZ <= 0) return null;
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial
        color="#22c55e"
        metalness={0.03}
        roughness={0.55}
        clippingPlanes={[clippingPlane]}
        depthWrite
        depthTest
      />
    </mesh>
  );
}

/**
 * SLA podpory jako skutečná geometrie: patka → kuželový sloup → top segment
 * → kontaktní bod + diagonální vzpěry. Rasterová maska zůstává pouze pro tisk.
 */
function SupportMesh({
  preview,
  printer,
  cutZ,
}: {
  preview: SupportPreviewData;
  printer: PrinterProfile;
  cutZ: number;
}) {
  const sx = printer.printX / preview.resolutionX;
  const sy = printer.printY / preview.resolutionY;
  const mmPerPx = Math.min(sx, sy);
  const radius = Math.max(0.08, preview.radiusPx * mmPerPx);
  const tipRadius = Math.max(0.06, preview.tipPx * mmPerPx);
  const bottomRadius = Math.max(radius, preview.bottomRadiusPx * mmPerPx);
  const braceRadius = Math.max(0.06, preview.braceRadiusPx * mmPerPx);
  const clippingPlane = useMemo(
    () => new THREE.Plane(new THREE.Vector3(0, 0, -1), cutZ),
    [cutZ]
  );

  const world = useCallback(
    (x: number, y: number, layer: number): [number, number, number] => [
      (x + 0.5) * sx - printer.printX / 2,
      (y + 0.5) * sy - printer.printY / 2,
      Math.max(0, (layer + 0.5) * preview.layerHeight),
    ],
    [sx, sy, printer.printX, printer.printY, preview.layerHeight]
  );

  const data = useMemo(() => {
    const shafts: PreviewSegment[] = [];
    const tops: PreviewSegment[] = [];
    const feet: PreviewSegment[] = [];
    const braces: PreviewSegment[] = [];
    const tips: { p: [number, number, number]; radius: number }[] = [];
    for (const p of preview.pillars) {
      const base = world(p.x, p.y, 0);
      base[2] = 0;
      const shaftTop = world(p.x, p.y, p.top);
      const anchor = world(p.anchorX, p.anchorY, p.anchorLayer);
      const footH = Math.min(1.2, Math.max(preview.layerHeight, shaftTop[2] * 0.12));
      feet.push({ a: base, b: [base[0], base[1], footH], radius: bottomRadius });
      if (shaftTop[2] > footH) {
        shafts.push({
          a: [base[0], base[1], footH * 0.65],
          b: shaftTop,
          radius,
        });
      }
      tops.push({ a: shaftTop, b: anchor, radius });
      tips.push({ p: anchor, radius: tipRadius });
    }
    for (const b of preview.braces) {
      braces.push({
        a: world(b.x1, b.y1, b.l1),
        b: world(b.x2, b.y2, b.l2),
        radius: braceRadius,
      });
    }
    return { shafts, tops, feet, braces, tips };
  }, [preview, world, radius, tipRadius, bottomRadius, braceRadius]);

  const shaftGeometry = useMemo(
    () => new THREE.CylinderGeometry(1, bottomRadius / radius, 1, 14, 1, false),
    [bottomRadius, radius]
  );
  const topGeometry = useMemo(
    () => new THREE.CylinderGeometry(tipRadius / radius, 1, 1, 14, 1, false),
    [tipRadius, radius]
  );
  const cylinderGeometry = useMemo(
    () => new THREE.CylinderGeometry(1, 1, 1, 12, 1, false),
    []
  );
  const tipGeometry = useMemo(() => new THREE.SphereGeometry(1, 12, 8), []);
  useEffect(
    () => () => {
      shaftGeometry.dispose();
      topGeometry.dispose();
      cylinderGeometry.dispose();
      tipGeometry.dispose();
    },
    [shaftGeometry, topGeometry, cylinderGeometry, tipGeometry]
  );

  return (
    <>
      <RaftPreview preview={preview} printer={printer} cutZ={cutZ} />
      <SegmentInstances segments={data.feet} geometry={cylinderGeometry} clippingPlane={clippingPlane} color="#22c55e" />
      <SegmentInstances segments={data.shafts} geometry={shaftGeometry} clippingPlane={clippingPlane} color="#22c55e" />
      <SegmentInstances segments={data.tops} geometry={topGeometry} clippingPlane={clippingPlane} color="#4ade80" />
      <SegmentInstances segments={data.braces} geometry={cylinderGeometry} clippingPlane={clippingPlane} color="#16a34a" />
      <TipInstances tips={data.tips} geometry={tipGeometry} clippingPlane={clippingPlane} />
    </>
  );
}

function Model({
  mesh,
  color,
  clipPlane,
}: {
  mesh: StlMesh;
  color: string;
  clipPlane?: THREE.Plane | null;
}) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    const { min, max } = mesh.bounds;
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    g.translate(-cx, -cy, -min[2]); // vycentrovat a postavit na z=0
    g.computeBoundingSphere();
    return g;
  }, [mesh]);

  // POZOR: THREE drží poloprostor normal·p + constant >= 0.
  // Náhled vrstvy musí skutečně skrýt vše NAD řezem (z <= layerZ).
  const layerZ = clipPlane ? -clipPlane.constant : 0;
  const below = useMemo(
    () => (clipPlane ? new THREE.Plane(new THREE.Vector3(0, 0, -1), layerZ) : null),
    [clipPlane, layerZ]
  );

  if (!clipPlane) {
    return (
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial
          color={color}
          metalness={0.2}
          roughness={0.32}
          envMapIntensity={0.9}
          side={THREE.DoubleSide}
        />
      </mesh>
    );
  }

  // Řez: vykreslí se pouze skutečně vytištěná spodní část modelu.
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial
        color={color}
        metalness={0.2}
        roughness={0.32}
        envMapIntensity={0.9}
        side={THREE.DoubleSide}
        clippingPlanes={[below!]}
      />
    </mesh>
  );
}

/** Tisková deska — jemný grid ohraničený na plochu tisku (ostré linky, žádné fade přes vanu). */
function BuildPlate({ printer }: { printer: PrinterProfile }) {
  return (
    <Grid
      position={[0, 0, 0.01]}
      args={[printer.printX, printer.printY]}
      cellSize={10}
      cellThickness={0.4}
      cellColor="#2b3442"
      sectionSize={50}
      sectionThickness={0.9}
      sectionColor="#3b4657"
    />
  );
}

/** Virtuální vana (build volume) — jemné sklo + hrany. */
function Vat({ printer }: { printer: PrinterProfile }) {
  return (
    <group position={[0, 0, printer.printZ / 2]}>
      <mesh>
        <boxGeometry args={[printer.printX, printer.printY, printer.printZ]} />
        <meshBasicMaterial
          color="#3b82f6"
          transparent
          opacity={0.04}
          depthWrite={false}
          side={THREE.BackSide}
        />
        <Edges scale={1} color="#2f4a6b" />
      </mesh>
    </group>
  );
}

/** Kamera na celou vanu — deska vodorovně, model svisle (up = +Z). */
function FrameVat({ printer }: { printer: PrinterProfile }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    const s = Math.max(printer.printX, printer.printY);
    camera.up.set(0, 0, 1); // důležité: naše scéna má "nahoru" ve směru Z
    camera.position.set(s * 1.05, s * 0.62, s * 1.25);
    camera.lookAt(0, printer.printZ * 0.26, 0);
    camera.updateProjectionMatrix();
  }, [printer, camera]);
  return null;
}

export default function Viewport({
  models,
  selectedId,
  onMove,
  onBake,
  printer,
  layerPreview,
  gizmoMode = "translate",
  supportPreview,
}: {
  models: ViewModel[];
  selectedId: number | null;
  onMove: (id: number, x: number, y: number) => void;
  onBake?: (id: number, rotation: { rx: number; ry: number; rz: number }, scale: number) => void;
  printer: PrinterProfile;
  layerPreview?: LayerPreviewData | null;
  gizmoMode?: "translate" | "rotate" | "scale";
  supportPreview?: SupportPreviewData | null;
}) {
  const gizmoRef = useRef<THREE.Group>(null);
  const orbitRef = useRef<any>(null);
  const [orbitEnabled, setOrbitEnabled] = useState(true);
  const rad2deg = (r: number) => (r * 180) / Math.PI;

  // model se skutečně ořízne na aktuální vrstvě; horní část se nevykresluje
  const clipPlane = useMemo(
    () =>
      layerPreview
        ? new THREE.Plane(new THREE.Vector3(0, 0, 1), -layerPreview.z)
        : null,
    [layerPreview]
  );

  const commitGizmo = () => {
    const g = gizmoRef.current;
    if (!g) return;
    if (gizmoMode === "translate") {
      onMove(selectedId!, g.position.x, g.position.y);
    } else {
      onBake?.(
        selectedId!,
        {
          rx: rad2deg(g.rotation.x),
          ry: rad2deg(g.rotation.y),
          rz: rad2deg(g.rotation.z),
        },
        g.scale.x
      );
      // po zapsání do dat modelu resetovat gyro
      g.rotation.set(0, 0, 0);
      g.scale.set(1, 1, 1);
      const pivotZ = g.userData.pivotZ ?? 0;
      g.position.z = pivotZ;
    }
    setOrbitEnabled(true);
  };

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      camera={{ position: [200, 160, 260], up: [0, 0, 1], fov: 45, near: 1, far: 4000 }}
      onCreated={(state) => {
        state.gl.localClippingEnabled = true;
      }}
    >
      <color attach="background" args={["#0b0e13"]} />
      <fog attach="fog" args={["#0b0e13", 900, 2600]} />

      {/* studio odrazy (PBR materiály vypadají mnohem líp) */}
      <Environment preset="studio" />

      <ambientLight intensity={0.4} />
      <directionalLight
        position={[140, 200, 100]}
        intensity={1.4}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0001}
      />
      <directionalLight position={[-100, 60, -80]} intensity={0.35} color="#8ab4ff" />

      <BuildPlate printer={printer} />
      <Vat printer={printer} />
      {/* Žádná rasterová vrstva přes model: při řezu zůstává vidět původní STL
          mesh 1:1. Starý downsampled zelený rastr byl zdrojem voxelového vzhledu. */}

      {/* SLA podpory jako hladké geometrické prvky; nikdy se nerekonstruují z pixelů. */}
      {supportPreview && layerPreview && (
        <SupportMesh
          preview={supportPreview}
          printer={printer}
          cutZ={layerPreview.z}
        />
      )}

      {models.map((m) => {
        let color = "#5b9cf6";
        if (m.id === selectedId) color = "#f5a524";
        else if (!m.fits) color = "#ef4444";
        const isSel = m.id === selectedId;
        const h = m.mesh.bounds.max[2] - m.mesh.bounds.min[2];
        return (
          <group
            key={m.id}
            ref={isSel ? gizmoRef : undefined}
            position={[m.transform.x, m.transform.y, h / 2]}
          >
            {/* pivot = střed modelu (rotace/škálování kolem něj) */}
            <group position={[0, 0, -h / 2]}>
              <Model mesh={m.mesh} color={color} clipPlane={clipPlane} />
            </group>
          </group>
        );
      })}

      <ContactShadows
        position={[0, 0, 0.02]}
        opacity={0.45}
        scale={printer.printX}
        blur={2.2}
        far={printer.printZ}
        resolution={512}
      />

      {selectedId !== null && !layerPreview && (
        <TransformControls
          object={gizmoRef as any}
          mode={gizmoMode}
          size={0.9}
          onObjectChange={() => {
            if (gizmoMode === "translate" && gizmoRef.current) {
              const g = gizmoRef.current;
              onMove(selectedId, g.position.x, g.position.y);
              // Z zamčený — pivot zůstává ve středu modelu
              g.position.z = g.userData.pivotZ ?? 0;
            }
          }}
          onMouseDown={() => {
            setOrbitEnabled(false);
            if (gizmoRef.current) {
              gizmoRef.current.userData.pivotZ = gizmoRef.current.position.z;
            }
          }}
          onMouseUp={commitGizmo}
        />
      )}

      <FrameVat printer={printer} />
      <OrbitControls
        ref={orbitRef}
        makeDefault
        enableDamping
        dampingFactor={0.12}
        enabled={orbitEnabled}
      />
    </Canvas>
  );
}
