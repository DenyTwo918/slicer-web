"use client";

import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, Grid, TransformControls } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { StlMesh } from "@/lib/stl";
import type { ModelTransform } from "@/lib/transform";

interface ViewModel {
  id: number;
  mesh: StlMesh;
  transform: ModelTransform;
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

/** Po první přidání modelu natočí kameru na celou desku. */
function FrameScene({ count }: { count: number }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    if (count === 1) {
      camera.position.set(150, 120, 240);
      camera.lookAt(0, 30, 0);
    }
  }, [count, camera]);
  return null;
}

export default function Viewport({
  models,
  selectedId,
  onMove,
}: {
  models: ViewModel[];
  selectedId: number | null;
  onMove: (id: number, x: number, y: number) => void;
}) {
  const selectedRef = useRef<THREE.Group>(null);
  const orbitRef = useRef<any>(null);
  const [orbitEnabled, setOrbitEnabled] = useState(true);

  return (
    <Canvas shadows camera={{ position: [150, 120, 240], fov: 45 }}>
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
        fadeDistance={400}
        infiniteGrid
      />
      {models.map((m) => (
        <group
          key={m.id}
          ref={m.id === selectedId ? selectedRef : undefined}
          position={[m.transform.x, m.transform.y, 0]}
        >
          <Model mesh={m.mesh} color={m.id === selectedId ? "#f59e0b" : "#4f8ef7"} />
        </group>
      ))}

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

      <FrameScene count={models.length} />
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
