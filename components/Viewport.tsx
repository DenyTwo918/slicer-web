"use client";

import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, Grid, TransformControls, Edges } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
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

function Model({ mesh, color }: { mesh: StlMesh; color: string }) {
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
  return (
    <mesh geometry={geometry} castShadow>
      <meshStandardMaterial
        color={color}
        metalness={0.15}
        roughness={0.35}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/** Virtuální vana (build volume) tiskárny — průhledný box s hranami. */
function BuildVolume({ printer }: { printer: PrinterProfile }) {
  return (
    <group position={[0, 0, printer.printZ / 2]}>
      <mesh>
        <boxGeometry args={[printer.printX, printer.printY, printer.printZ]} />
        <meshBasicMaterial
          color="#3b82f6"
          transparent
          opacity={0.05}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
        <Edges scale={1} color="#60a5fa" />
      </mesh>
    </group>
  );
}

/** Kamera na celou vanu (při startu / změně tiskárny). */
function FrameVat({ printer }: { printer: PrinterProfile }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    const s = Math.max(printer.printX, printer.printY);
    camera.position.set(s * 0.85, s * 0.7, s * 1.05);
    camera.lookAt(0, printer.printZ * 0.3, 0);
  }, [printer, camera]);
  return null;
}

export default function Viewport({
  models,
  selectedId,
  onMove,
  printer,
}: {
  models: ViewModel[];
  selectedId: number | null;
  onMove: (id: number, x: number, y: number) => void;
  printer: PrinterProfile;
}) {
  const selectedRef = useRef<THREE.Group>(null);
  const orbitRef = useRef<any>(null);
  const [orbitEnabled, setOrbitEnabled] = useState(true);

  return (
    <Canvas shadows camera={{ position: [200, 160, 260], fov: 45 }}>
      <ambientLight intensity={0.7} />
      <directionalLight position={[120, 180, 90]} intensity={1.4} castShadow />
      <hemisphereLight intensity={0.35} />
      <Grid
        position={[0, 0, 0]}
        cellSize={5}
        cellThickness={0.6}
        cellColor="#cbd5e1"
        sectionSize={25}
        sectionThickness={1.1}
        sectionColor="#94a3b8"
        fadeDistance={600}
        infiniteGrid
      />

      <BuildVolume printer={printer} />

      {models.map((m) => {
        let color = "#4f8ef7";
        if (m.id === selectedId) color = "#f59e0b";
        else if (!m.fits) color = "#ef4444"; // přesahuje vanu
        return (
          <group
            key={m.id}
            ref={m.id === selectedId ? selectedRef : undefined}
            position={[m.transform.x, m.transform.y, 0]}
          >
            <Model mesh={m.mesh} color={color} />
          </group>
        );
      })}

      {selectedId !== null && (
        <TransformControls
          object={selectedRef as any}
          mode="translate"
          size={0.9}
          onObjectChange={() => {
            if (selectedRef.current) {
              const p = selectedRef.current.position;
              onMove(selectedId, p.x, p.y);
            }
          }}
          onMouseDown={() => setOrbitEnabled(false)}
          onMouseUp={() => setOrbitEnabled(true)}
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
