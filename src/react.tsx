"use client";

import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Canvas } from "@react-three/fiber";
import { ContactShadows, OrbitControls, useAnimations, useGLTF } from "@react-three/drei";
import { Box3, LoopOnce, Vector3, type Group } from "three";

const SIZE = 2.1; // every model is scaled so its longest side is this many units

export interface BoxViewerProps {
  /** URL of the .glb file, e.g. "/models/box.glb". */
  src: string;
  /** Spin the model slowly. Default true (paused while unfolded). */
  autoRotate?: boolean;
  /** Let the user zoom with scroll / pinch. Default true. */
  zoom?: boolean;
  /** Show a soft shadow under the model. Default true. */
  shadow?: boolean;
  /** Canvas background colour. Default transparent. */
  background?: string;
  /**
   * Cartons only: how folded the carton is, from 0 (flat dieline) to 1 (closed box).
   * Leave it out to show the closed box, or use `foldControls` for a built-in slider.
   */
  fold?: number;
  /** Cartons only: show a fold slider under the model. */
  foldControls?: boolean;
  /** Cartons only: on load, play the fold from flat to closed once. */
  playFold?: boolean;
  className?: string;
  style?: CSSProperties;
}

function Model({ src, fold }: { src: string; fold?: number }) {
  const { scene, animations } = useGLTF(src);
  const group = useRef<Group>(null);
  const { actions } = useAnimations(animations, group);
  // Size the model from its default (closed) pose, before any animation moves it
  const { scale, offset } = useMemo(() => {
    const box = new Box3().setFromObject(scene);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const s = SIZE / Math.max(size.x, size.y, size.z);
    return { scale: s, offset: center.multiplyScalar(-s) };
  }, [scene]);

  const action = actions.fold;
  useEffect(() => {
    if (!action || fold === undefined) return;
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    action.paused = true;
    return () => {
      action.stop();
    };
  }, [action, fold === undefined]);
  useEffect(() => {
    if (!action || fold === undefined) return;
    action.time = Math.min(0.999999, Math.max(0, fold)) * action.getClip().duration;
    action.getMixer().update(0);
  }, [action, fold]);

  return (
    <group position={offset} scale={scale}>
      <group ref={group}>
        <primitive object={scene} />
      </group>
    </group>
  );
}

/** A drop-in 3D viewer for a .glb model: rotate, zoom, auto-fit, and fold / unfold cartons. Give it a height via className or style. */
export function BoxViewer({ src, autoRotate = true, zoom = true, shadow = true, background, fold, foldControls, playFold, className, style }: BoxViewerProps) {
  const [local, setLocal] = useState(playFold ? 0 : 1);
  const controlled = fold !== undefined;
  const value = controlled ? fold : local;

  useEffect(() => {
    if (!playFold || controlled) return;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 3500);
      setLocal(t);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playFold, controlled]);

  const useFold = controlled || foldControls || playFold;
  return (
    <div className={className} style={{ position: "relative", width: "100%", height: 480, ...style }}>
      <Canvas camera={{ position: [2.2, 1.2, 4.2], fov: 35 }} dpr={[1, 2]}>
        {background && <color attach="background" args={[background]} />}
        <ambientLight intensity={1.6} />
        <directionalLight position={[5, 8, 5]} intensity={1.6} />
        <directionalLight position={[-5, 3, -4]} intensity={0.8} />
        <Suspense fallback={null}>
          <Model src={src} fold={useFold ? value : undefined} />
          {shadow && <ContactShadows position={[0, -SIZE / 2 - 0.01, 0]} opacity={0.35} blur={2.5} scale={6} />}
        </Suspense>
        <OrbitControls
          makeDefault
          target={[0, 0, 0]}
          autoRotate={autoRotate && value >= 0.999}
          autoRotateSpeed={1.5}
          enablePan={false}
          enableZoom={zoom}
          minDistance={2}
          maxDistance={12}
        />
      </Canvas>
      {foldControls && !controlled && (
        <label style={{ position: "absolute", left: 16, right: 16, bottom: 12, display: "flex", alignItems: "center", gap: 10, font: "13px system-ui, sans-serif", color: "#555" }}>
          Flat
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={local}
            onChange={(e) => setLocal(Number(e.target.value))}
            style={{ flex: 1 }}
            aria-label="Fold the carton"
          />
          Folded
        </label>
      )}
    </div>
  );
}

export default BoxViewer;
