"use client";

import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { StlMesh } from "@/lib/stl";

function Model({ mesh }: { mesh: StlMesh }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    // vycentrovat nad deskou: postavit na z=0 a srovnat do středu
    const { min, max } = mesh.bounds;
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    g.translate(-cx, -cy, -min[2]);
    g.computeBoundingSphere();
    return g;
  }, [mesh]);

  return (
    <mesh geometry={geometry} castShadow>
      <meshStandardMaterial
        color="#4f8ef7"
        metalness={0.15}
        roughness={0.35}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/** Po načtení modelu natočí kameru tak, aby byl celý vidět. */
function FrameModel({ mesh }: { mesh: StlMesh | null }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    if (!mesh) return;
    const { min, max } = mesh.bounds;
    const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1);
    camera.position.set(size * 1.4, size * 1.1, size * 2.2);
    camera.lookAt(0, size * 0.25, 0);
  }, [mesh, camera]);
  return null;
}

export default function Viewport({ mesh }: { mesh: StlMesh | null }) {
  return (
    <Canvas shadows camera={{ position: [140, 110, 220], fov: 45 }}>
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
      {mesh && <Model mesh={mesh} />}
      <FrameModel mesh={mesh} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
    </Canvas>
  );
}
