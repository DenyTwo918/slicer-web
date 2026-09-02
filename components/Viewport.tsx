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
import {
  simplifyClosedPreviewContour,
  traceMaskContours,
  type PreviewPoint2 as Point2,
} from "@/lib/previewContour";
import {
  bitmapPointToPlate,
  viewportMeshPlacement,
} from "@/lib/previewCoordinates";
import { buildViewportModelGeometry } from "@/lib/viewportGeometry";
import { buildMeshRepairOverlay } from "@/lib/meshRepairOverlay";
import { shouldShowMeshDiagnosticOverlay } from "@/lib/meshDiagnosticVisibility";
import type { MeshIssueSample } from "@/lib/meshRepair";
import type { CutPlane } from "@/lib/meshCut";
import { localPlaneToWorld, worldPlaneToLocal } from "@/lib/meshCutPlane";

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
  /** Crop position inside the printer's native LCD bitmap. */
  offsetX?: number;
  offsetY?: number;
  fullResX?: number;
  fullResY?: number;
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
  printer: PrinterProfile,
  preserveHoles = false,
  threshold = 0,
  smooth: boolean | "faithful" = true,
  mapping?: { offsetX: number; offsetY: number; fullWidth: number; fullHeight: number }
): THREE.Shape[] {
  if (width <= 0 || height <= 0 || mask.length === 0) return [];
  const loops = traceMaskContours(mask, width, height, threshold);

  const sx = printer.printX / (mapping?.fullWidth ?? width);
  const sy = printer.printY / (mapping?.fullHeight ?? height);
  const tolerancePx = smooth === "faithful"
    ? 0.75
    : smooth
      ? Math.max(1, 0.65 / Math.min(sx, sy))
      : 0;
  const pointInLoop = (loop: Point2[], point: Point2) => {
    let inside = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i], b = loop[j];
      if (((a.y > point.y) !== (b.y > point.y)) &&
          point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  const entries: { loop: Point2[]; area: number; shape?: THREE.Shape }[] = [];
  for (const loop of loops) {
    let area = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      area += a.x * b.y - b.x * a.y;
    }
    if (Math.abs(area) < 4) continue;
    // Tisková vrstva musí být 1:1 s bitmapou. Chaikin + RDP jsou vhodné pro
    // vizuální raft, ale u duté skořepiny posouvaly stěny, zavíraly malé otvory
    // a vytvářely zdánlivé vady, které ve skutečné vrstvě nebyly.
    const simplified = smooth
      ? simplifyClosedPreviewContour(loop, tolerancePx)
      : loop;
    const displayLoop = smooth === true ? smoothClosed(simplified) : simplified;
    if (displayLoop.length < 3) continue;
    entries.push({ loop: displayLoop, area });
  }

  const shapes: THREE.Shape[] = [];
  const writePath = (path: THREE.Path, loop: Point2[]) => {
    loop.forEach((p, i) => {
      const world = bitmapPointToPlate(p, {
        offsetX: mapping?.offsetX ?? 0,
        offsetY: mapping?.offsetY ?? 0,
        fullWidth: mapping?.fullWidth ?? width,
        fullHeight: mapping?.fullHeight ?? height,
      }, printer);
      if (i === 0) path.moveTo(world.x, world.y);
      else path.lineTo(world.x, world.y);
    });
    path.closePath();
  };
  for (const entry of entries.filter((x) => x.area > 0)) {
    const shape = new THREE.Shape();
    writePath(shape, entry.loop);
    entry.shape = shape;
    shapes.push(shape);
  }
  if (preserveHoles) {
    for (const hole of entries.filter((x) => x.area < 0)) {
      const parent = entries
        .filter((x) => x.area > 0 && x.shape && pointInLoop(x.loop, hole.loop[0]))
        .sort((a, b) => Math.abs(a.area) - Math.abs(b.area))[0];
      if (!parent?.shape) continue;
      const path = new THREE.Path();
      writePath(path, hole.loop);
      parent.shape.holes.push(path);
    }
  }
  return shapes;
}

/** Skutečná aktuální tisková vrstva — vektorově, bez voxelové textury. */
function SliceLayerSurface({ layer, printer }: { layer: LayerPreviewData; printer: PrinterProfile }) {
  const geometry = useMemo(() => {
    // Přímý obrys nativní PW0 vrstvy. Crop šetří paměť; mapping jej vrací na
    // přesné souřadnice LCD bez zvětšování 1/16 pracovního rastru.
    const mapping = layer.fullResX && layer.fullResY ? {
      offsetX: layer.offsetX ?? 0,
      offsetY: layer.offsetY ?? 0,
      fullWidth: layer.fullResX,
      fullHeight: layer.fullResY,
    } : undefined;
    const shapes = raftShapes(
      layer.data, layer.resX, layer.resY, printer, true, 24, "faithful", mapping
    );
    if (shapes.length === 0) return null;
    const g = new THREE.ShapeGeometry(shapes);
    g.translate(0, 0, layer.z + 0.006);
    return g;
  }, [layer, printer]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return (
    <mesh geometry={geometry} renderOrder={3}>
      <meshStandardMaterial
        color="#2563eb"
        emissive="#172554"
        emissiveIntensity={0.06}
        roughness={0.42}
        metalness={0.03}
        side={THREE.DoubleSide}
        polygonOffset
        polygonOffsetFactor={-2}
      />
    </mesh>
  );
}

/** Raft jako skutečný vektorový extrudovaný mesh, nikoli pixelová textura. */
export function buildRaftPreviewGeometries(
  preview: SupportPreviewData,
  printer: PrinterProfile,
): THREE.BufferGeometry[] {
  const exactLayers = preview.raftLayerMasks?.filter((mask) => mask.length > 0) ?? [];
  if (exactLayers.length > 0) {
    return exactLayers.flatMap((mask, layerIndex) => {
      const shapes = raftShapes(
        mask,
        preview.resolutionX,
        preview.resolutionY,
        printer,
        true,
        0,
        true,
      );
      if (shapes.length === 0) return [];
      const geometry = new THREE.ExtrudeGeometry(shapes, {
        depth: preview.layerHeight,
        bevelEnabled: false,
        curveSegments: 4,
      });
      geometry.translate(0, 0, layerIndex * preview.layerHeight);
      return [geometry];
    });
  }
  const mask = preview.raftMask;
  if (!mask || mask.length === 0) return [];
  const shapes = raftShapes(
    mask,
    preview.resolutionX,
    preview.resolutionY,
    printer,
    true,
  );
  if (shapes.length === 0) return [];
  return [new THREE.ExtrudeGeometry(shapes, {
    depth: Math.max(preview.layerHeight, (preview.raftLayers ?? 1) * preview.layerHeight),
    bevelEnabled: false,
    curveSegments: 4,
  })];
}

function RaftPreview({
  preview,
  printer,
  cutZ,
}: {
  preview: SupportPreviewData;
  printer: PrinterProfile;
  cutZ: number;
}) {
  const geometries = useMemo(
    () => buildRaftPreviewGeometries(preview, printer),
    [preview, printer],
  );
  const clippingPlane = useMemo(
    () => new THREE.Plane(new THREE.Vector3(0, 0, -1), cutZ),
    [cutZ]
  );
  useEffect(() => () => geometries.forEach((geometry) => geometry.dispose()), [geometries]);
  if (geometries.length === 0 || cutZ <= 0) return null;
  return (
    <group>
      {geometries.map((geometry, index) => (
        <mesh key={index} geometry={geometry} castShadow receiveShadow>
          <meshStandardMaterial
            color="#22c55e"
            metalness={0.03}
            roughness={0.55}
            clippingPlanes={[clippingPlane]}
            depthWrite
            depthTest
          />
        </mesh>
      ))}
    </group>
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
  geometryOffset,
}: {
  mesh: StlMesh;
  color: string;
  clipPlane?: THREE.Plane | null;
  geometryOffset: { x: number; y: number };
}) {
  const geometry = useMemo(
    () => buildViewportModelGeometry(mesh, geometryOffset),
    [mesh, geometryOffset.x, geometryOffset.y]
  );

  // POZOR: THREE drží poloprostor normal·p + constant >= 0.
  // Náhled vrstvy musí skutečně skrýt vše NAD řezem (z <= layerZ).
  const layerZ = clipPlane ? -clipPlane.constant : 0;
  const below = useMemo(
    () => (clipPlane ? new THREE.Plane(new THREE.Vector3(0, 0, -1), layerZ) : null),
    [clipPlane, layerZ]
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

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
        color="#3b82f6"
        metalness={0.08}
        roughness={0.4}
        envMapIntensity={0.75}
        side={THREE.DoubleSide}
        clippingPlanes={[below!]}
      />
    </mesh>
  );
}

function CutPreviewModel({ mesh, geometryOffset, plane }: { mesh: StlMesh; geometryOffset:{x:number;y:number}; plane:THREE.Plane }) {
  const geometry=useMemo(()=>buildViewportModelGeometry(mesh,geometryOffset),[mesh,geometryOffset.x,geometryOffset.y]);
  useEffect(()=>()=>geometry.dispose(),[geometry]);
  const opposite=useMemo(()=>plane.clone().negate(),[plane]);
  return <>
    <mesh geometry={geometry}><meshStandardMaterial color="#3b82f6" side={THREE.DoubleSide} clippingPlanes={[plane]} roughness={0.38}/></mesh>
    <mesh geometry={geometry}><meshStandardMaterial color="#f59e0b" side={THREE.DoubleSide} clippingPlanes={[opposite]} roughness={0.38}/></mesh>
  </>;
}

function CutPlaneGizmo({plane,mode,onChange,onDrag}:{plane:THREE.Plane;mode:"translate"|"rotate";onChange:(plane:THREE.Plane)=>void;onDrag:(active:boolean)=>void}){
  const ref=useRef<THREE.Group>(null);
  useEffect(()=>{const group=ref.current;if(!group)return;const normal=plane.normal.clone().normalize();group.position.copy(normal).multiplyScalar(-plane.constant);group.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),normal);},[plane]);
  const emit=()=>{const group=ref.current;if(!group)return;const normal=new THREE.Vector3(0,0,1).applyQuaternion(group.quaternion).normalize();onChange(new THREE.Plane(normal,-normal.dot(group.position)));};
  return <>
    <group ref={ref}>
      <mesh renderOrder={30}><planeGeometry args={[140,140]}/><meshBasicMaterial color="#22d3ee" transparent opacity={0.16} side={THREE.DoubleSide} depthWrite={false}/></mesh>
      <lineSegments renderOrder={31}><edgesGeometry args={[new THREE.PlaneGeometry(140,140)]}/><lineBasicMaterial color="#67e8f9" depthTest={false}/></lineSegments>
    </group>
    <TransformControls object={ref as any} mode={mode} size={0.85} onObjectChange={emit} onMouseDown={()=>onDrag(true)} onMouseUp={()=>{emit();onDrag(false);}}/>
  </>;
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

function MeshDiagnosticOverlay({
  mesh,
  sample,
  geometryOffset,
}: {
  mesh: StlMesh;
  sample: MeshIssueSample;
  geometryOffset: { x: number; y: number };
}) {
  const geometry = useMemo(
    () => buildMeshRepairOverlay(mesh, sample, geometryOffset),
    [mesh, sample, geometryOffset.x, geometryOffset.y],
  );
  useEffect(() => () => {
    geometry.triangles?.dispose();
    geometry.edges?.dispose();
    geometry.markers?.dispose();
  }, [geometry]);

  return (
    <>
      {geometry.triangles && (
        <mesh geometry={geometry.triangles} renderOrder={20}>
          <meshBasicMaterial
            color="#ff3344"
            transparent
            opacity={0.72}
            depthTest={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      {geometry.edges && (
        <lineSegments geometry={geometry.edges} renderOrder={21}>
          <lineBasicMaterial color="#ff1738" depthTest={false} />
        </lineSegments>
      )}
      {geometry.markers && (
        <points geometry={geometry.markers} renderOrder={22}>
          <pointsMaterial
            color="#ff002b"
            size={10}
            sizeAttenuation={false}
            depthTest={false}
          />
        </points>
      )}
    </>
  );
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
  meshDiagnostic,
  cutPreview,
  cutGizmoMode = "translate",
  onCutPlaneChange,
}: {
  models: ViewModel[];
  selectedId: number | null;
  onMove: (id: number, x: number, y: number) => void;
  onBake?: (id: number, rotation: { rx: number; ry: number; rz: number }, scale: number) => void;
  printer: PrinterProfile;
  layerPreview?: LayerPreviewData | null;
  gizmoMode?: "translate" | "rotate" | "scale";
  supportPreview?: SupportPreviewData | null;
  meshDiagnostic?: { modelId: number; sample: MeshIssueSample } | null;
  cutPreview?: { modelId:number; plane:CutPlane } | null;
  cutGizmoMode?: "translate"|"rotate";
  onCutPlaneChange?: (plane:CutPlane)=>void;
}) {
  const gizmoRef = useRef<THREE.Group>(null);
  const orbitRef = useRef<any>(null);
  const [orbitEnabled, setOrbitEnabled] = useState(true);
  const rad2deg = (r: number) => (r * 180) / Math.PI;
  const cutModel=cutPreview?models.find((model)=>model.id===cutPreview.modelId):undefined;
  const cutWorld=useMemo(()=>cutPreview&&cutModel?localPlaneToWorld(cutPreview.plane,cutModel.mesh.bounds,cutModel.transform):null,[cutPreview,cutModel]);
  const cutThreePlane=useMemo(()=>cutWorld?new THREE.Plane(new THREE.Vector3(...cutWorld.normal),cutWorld.constant):null,[cutWorld]);

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

      {/* Modrý povrch je skutečná aktuální tisková vrstva; slider tak skládá
          model vrstvu po vrstvě místo falešné bílé výplně řezu. */}
      {layerPreview && <SliceLayerSurface layer={layerPreview} printer={printer} />}

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
        const placement = viewportMeshPlacement(m.mesh.bounds, m.transform);
        return (
          <group
            key={m.id}
            ref={isSel ? gizmoRef : undefined}
            position={[placement.groupX, placement.groupY, h / 2 + m.transform.z]}
            rotation={[
              THREE.MathUtils.degToRad(m.transform.rx),
              THREE.MathUtils.degToRad(m.transform.ry),
              THREE.MathUtils.degToRad(m.transform.rz),
            ]}
            scale={m.transform.scale}
          >
            {/* pivot = střed modelu (rotace/škálování kolem něj) */}
            <group position={[0, 0, -h / 2]}>
              {cutThreePlane && cutPreview?.modelId===m.id ? (
                <CutPreviewModel mesh={m.mesh} geometryOffset={{x:placement.geometryX,y:placement.geometryY}} plane={cutThreePlane}/>
              ) : (
                <Model mesh={m.mesh} color={color} clipPlane={clipPlane} geometryOffset={{ x: placement.geometryX, y: placement.geometryY }}/>
              )}
              {meshDiagnostic && shouldShowMeshDiagnosticOverlay({
                modelId: m.id,
                diagnosticModelId: meshDiagnostic.modelId,
                layerPreviewActive: Boolean(layerPreview),
              }) && (
                <MeshDiagnosticOverlay
                  mesh={m.mesh}
                  sample={meshDiagnostic.sample}
                  geometryOffset={{ x: placement.geometryX, y: placement.geometryY }}
                />
              )}
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

      {cutThreePlane && cutModel && onCutPlaneChange && (
        <CutPlaneGizmo plane={cutThreePlane} mode={cutGizmoMode} onDrag={(active)=>setOrbitEnabled(!active)} onChange={(world)=>onCutPlaneChange(worldPlaneToLocal({normal:world.normal.toArray() as [number,number,number],constant:world.constant},cutModel.mesh.bounds,cutModel.transform))}/>
      )}

      {selectedId !== null && !layerPreview && !cutPreview && (
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
