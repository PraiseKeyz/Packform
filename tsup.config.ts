import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/react.tsx"],
  format: ["esm"],
  dts: { entry: ["src/index.ts", "src/react.tsx"] },
  clean: true,
  sourcemap: true,
  target: "node20",
  external: ["react", "three", "@react-three/fiber", "@react-three/drei"],
});
