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
}

/** Převede rastr vrstvy na canvas texturu (flipY opraví Y směr). */
function rasterToTexture(
  data: Uint8Array,
  resX: number,
  resY: number,
  scale: number,
  flipY: boolean
): THREE.CanvasTexture {
  const w = Math.max(1, Math.floor(resX / scale));
  const h = Math.max(1, Math.floor(resY / scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d ctx");
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const sy = flipY ? resY - 1 - Math.floor(y * scale) : Math.floor(y * scale);
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(x * scale);
      const v = data[sy * resX + sx];
      const o = (y * w + x) * 4;
      img.data[o] = 255;
      img.data[o + 1] = 255;
      img.data[o + 2] = 255;
      img.data[o + 3] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/** Řezová rovina tisku — ukazuje aktuální vrstvu ve 3D (jako slicery).
 *  Textura se vytvoří JEDNOU a při posuvu se jen přepisuje (žádné nové textury → plynulé). */
function LayerPlane({
  preview,
  printer,
}: {
  preview: LayerPreviewData | null;
  printer: PrinterProfile;
}) {
  const planeRef = useRef<THREE.Mesh>(null);
  const [texture, setTexture] = useState<THREE.CanvasTexture | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!preview) {
      if (planeRef.current) planeRef.current.visible = false;
      return;
    }
    if (!texture) {
      const canvas = document.createElement("canvas");
      canvas.width = preview.resX;
      canvas.height = preview.resY;
      canvasRef.current = canvas;
      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      setTexture(tex);
      return;
    }
    // přepiš existující canvas (Y flip)
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const img = ctx.createImageData(preview.resX, preview.resY);
    for (let y = 0; y < preview.resY; y++) {
      const sy = preview.resY - 1 - y;
      for (let x = 0; x < preview.resX; x++) {
        const v = preview.data[sy * preview.resX + x];
        const o = (y * preview.resX + x) * 4;
        img.data[o] = 255;
        img.data[o + 1] = 255;
        img.data[o + 2] = 255;
        img.data[o + 3] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
    texture.needsUpdate = true;
    if (planeRef.current) {
      planeRef.current.position.z = preview.z + 0.02;
      planeRef.current.visible = true;
    }
  }, [preview, texture]);

  useEffect(() => {
    return () => {
      texture?.dispose();
      canvasRef.current = null;
    };
  }, [texture]);

  return (
    <mesh ref={planeRef} position={[0, 0, 0]} visible={false}>
      <planeGeometry args={[printer.printX, printer.printY]} />
      <meshBasicMaterial
        map={texture ?? undefined}
        color="#4ade80"
        transparent
        opacity={0.95}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/** Objem tisku — vrstvy jako 3D (raft, podpory i model).
 *  Vykreslí se JEDNOU; při posuvu slideru se jen přepíná visible (žádný re-render → plynulé). */
function PrintVolume({
  sliceResult,
  printer,
  cutZ,
}: {
  sliceResult: { layers: { z: number; data: Uint8Array }[]; resolutionX: number; resolutionY: number } | null;
  printer: PrinterProfile;
  cutZ: number | null;
}) {
  const quads = useMemo(() => {
    if (!sliceResult) return [];
    const step = 3; // každá 3. vrstva
    const arr: { z: number; tex: THREE.CanvasTexture }[] = [];
    for (let i = 0; i < sliceResult.layers.length; i += step) {
      const l = sliceResult.layers[i];
      arr.push({
        z: l.z,
        tex: rasterToTexture(l.data, sliceResult.resolutionX, sliceResult.resolutionY, 2, true),
      });
    }
    return arr;
  }, [sliceResult]);

  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);

  useEffect(() => {
    meshRefs.current.forEach((mesh, i) => {
      if (mesh && quads[i]) {
        mesh.visible = cutZ === null || quads[i].z <= cutZ + 0.001;
      }
    });
  }, [cutZ, quads]);

  useEffect(() => {
    return () => {
      quads.forEach((q) => q.tex.dispose());
    };
  }, [quads]);

  return (
    <group>
      {quads.map((q, idx) => (
        <mesh
          key={idx}
          ref={(el) => {
            meshRefs.current[idx] = el;
          }}
          position={[0, 0, q.z]}
        >
          <planeGeometry args={[printer.printX, printer.printY]} />
          <meshBasicMaterial
            map={q.tex}
            color="#bfdbfe"
            transparent
            opacity={0.85}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
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

  // POZOR: všechny hooky musí běžet vždy (bez podmínek) — jinak React #310
  const layerZ = clipPlane ? -clipPlane.constant : 0;
  const below = useMemo(
    () => (clipPlane ? new THREE.Plane(new THREE.Vector3(0, 0, 1), -layerZ) : null),
    [clipPlane, layerZ]
  );
  const above = useMemo(
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

  // řez: spodní část plná, horní část = ghost (průsvitný)
  return (
    <>
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
      <mesh geometry={geometry}>
        <meshStandardMaterial
          color="#9fb4d8"
          transparent
          opacity={0.22}
          depthWrite={false}
          side={THREE.DoubleSide}
          clippingPlanes={[above!]}
        />
      </mesh>
    </>
  );
}

/** Kovová tisková deska + jemná mřížka. */
function BuildPlate({ printer }: { printer: PrinterProfile }) {
  return (
    <group>
      <mesh position={[0, 0, -0.5]} receiveShadow>
        <boxGeometry args={[printer.printX, printer.printY, 1]} />
        <meshStandardMaterial color="#202733" metalness={0.7} roughness={0.35} />
      </mesh>
      <Grid
        position={[0, 0, 0.01]}
        args={[printer.printX, printer.printY]}
        cellSize={5}
        cellThickness={0.4}
        cellColor="#2b3442"
        sectionSize={25}
        sectionThickness={0.8}
        sectionColor="#3b4657"
        fadeDistance={printer.printX * 1.3}
      />
    </group>
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
  sliceResult,
}: {
  models: ViewModel[];
  selectedId: number | null;
  onMove: (id: number, x: number, y: number) => void;
  onBake?: (id: number, rotation: { rx: number; ry: number; rz: number }, scale: number) => void;
  printer: PrinterProfile;
  layerPreview?: LayerPreviewData | null;
  gizmoMode?: "translate" | "rotate" | "scale";
  sliceResult?: { layers: { z: number; data: Uint8Array }[]; resolutionX: number; resolutionY: number } | null;
}) {
  const gizmoRef = useRef<THREE.Group>(null);
  const orbitRef = useRef<any>(null);
  const [orbitEnabled, setOrbitEnabled] = useState(true);
  const rad2deg = (r: number) => (r * 180) / Math.PI;

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
      <LayerPlane preview={layerPreview ?? null} printer={printer} />

      {/* náhled tisku: objem vrstev pod řezem (raft + podpory + model) */}
      {layerPreview ? (
        <PrintVolume
          sliceResult={sliceResult ?? null}
          printer={printer}
          cutZ={layerPreview.z}
        />
      ) : (
        models.map((m) => {
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
                <Model mesh={m.mesh} color={color} clipPlane={null} />
              </group>
            </group>
          );
        })
      )}

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
