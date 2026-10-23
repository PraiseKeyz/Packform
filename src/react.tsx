"use client";

import { Suspense, useMemo, type CSSProperties } from "react";
import { Canvas } from "@react-three/fiber";
import { ContactShadows, OrbitControls, useGLTF } from "@react-three/drei";
import { Box3, Vector3 } from "three";

const SIZE = 2.4; // every model is scaled so its longest side is this many units

export interface BoxViewerProps {
  /** URL of the .glb file, e.g. "/models/box.glb". */
  src: string;
  /** Spin the model slowly. Default true. */
  autoRotate?: boolean;
  /** Let the user zoom with scroll / pinch. Default true. */
  zoom?: boolean;
  /** Show a soft shadow under the model. Default true. */
  shadow?: boolean;
  /** Canvas background colour. Default transparent. */
  background?: string;
  className?: string;
  style?: CSSProperties;
}

function Model({ src }: { src: string }) {
  const { scene } = useGLTF(src);
  // Center the model on the origin and scale it to a predictable size
  const { scale, offset } = useMemo(() => {
    const box = new Box3().setFromObject(scene);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const s = SIZE / Math.max(size.x, size.y, size.z);
    return { scale: s, offset: center.multiplyScalar(-s) };
  }, [scene]);
  return (
    <group position={offset} scale={scale}>
      <primitive object={scene} />
    </group>
  );
}

/** A drop-in 3D viewer for a .glb model: rotate, zoom, auto-fit. Give it a height via className or style. */
export function BoxViewer({ src, autoRotate = true, zoom = true, shadow = true, background, className, style }: BoxViewerProps) {
  return (
    <div className={className} style={{ width: "100%", height: 480, ...style }}>
      <Canvas camera={{ position: [2.2, 1.2, 4.2], fov: 35 }} dpr={[1, 2]}>
        {background && <color attach="background" args={[background]} />}
        <ambientLight intensity={1.6} />
        <directionalLight position={[5, 8, 5]} intensity={1.6} />
        <directionalLight position={[-5, 3, -4]} intensity={0.8} />
        <Suspense fallback={null}>
          <Model src={src} />
          {shadow && <ContactShadows position={[0, -SIZE / 2 - 0.01, 0]} opacity={0.35} blur={2.5} scale={6} />}
        </Suspense>
        <OrbitControls
          makeDefault
          target={[0, 0, 0]}
          autoRotate={autoRotate}
          autoRotateSpeed={1.5}
          enablePan={false}
          enableZoom={zoom}
          minDistance={2.5}
          maxDistance={9}
        />
      </Canvas>
    </div>
  );
}

export default BoxViewer;
