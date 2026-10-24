import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { artFor, buildProject, detectFramework, initProject, modelName, watchProject, type Manifest } from "../src/index";

const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const dirs: string[] = [];
async function project(deps: Record<string, string> = { next: "15.0.0" }, extra: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "packform-"));
  dirs.push(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "app", dependencies: deps }, null, 2));
  for (const [f, content] of Object.entries(extra)) await writeFile(path.join(root, f), content);
  return root;
}
const readJson = async (f: string) => JSON.parse(await readFile(f, "utf8"));
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("framework detection", () => {
  it.each([
    [{ next: "15" }, "Next.js", "public"],
    [{ vite: "6" }, "Vite", "public"],
    [{ "@sveltejs/kit": "2" }, "SvelteKit", "static"],
    [{ gatsby: "5" }, "Gatsby", "static"],
    [{}, "unknown", "public"],
  ])("%o → %s, %s/", async (deps, name, publicDir) => {
    expect(await detectFramework(await project(deps))).toEqual({ name, publicDir });
  });
});

describe("packform init", () => {
  it("creates the folders, config, git ignore entry and npm script", async () => {
    const root = await project({ next: "15" }, { ".gitignore": "node_modules\n.next" });
    const { changes } = await initProject(root);
    expect(changes).toHaveLength(5);
    expect(existsSync(path.join(root, "dielines"))).toBe(true);
    expect(existsSync(path.join(root, "public/packform"))).toBe(true);
    expect(await readJson(path.join(root, "packform.config.json"))).toMatchObject({ input: "dielines", output: "public/packform" });
    const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore.startsWith("node_modules\n.next\n")).toBe(true);
    expect(gitignore).toContain("\n/dielines/\n");
    expect((await readJson(path.join(root, "package.json"))).scripts.packform).toBe("packform build");
  });

  it("uses static/ for SvelteKit", async () => {
    const root = await project({ "@sveltejs/kit": "2" });
    const { config } = await initProject(root);
    expect(config.output).toBe("static/packform");
    expect(existsSync(path.join(root, "static/packform"))).toBe(true);
  });

  it("is safe to run again and never overwrites", async () => {
    const root = await project({ next: "15" }, { ".gitignore": "dielines/\n" });
    const pkg = await readJson(path.join(root, "package.json"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ ...pkg, scripts: { packform: "my own" } }));
    await initProject(root);
    const again = await initProject(root);
    expect(again.changes).toEqual([]);
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("dielines/\n"); // already ignored, left alone
    expect((await readJson(path.join(root, "package.json"))).scripts.packform).toBe("my own");
  });
});

describe("naming", () => {
  it("makes URL-safe model names", () => {
    expect(modelName("Medicine Box 50×50×120 mm.ai")).toBe("medicine-box-50x50x120-mm");
    expect(modelName("Crème_brûlée.PDF")).toBe("creme_brulee");
  });
  it("pairs name.art.<ext> with name.<ai|pdf>", () => {
    const files = ["box.ai", "box.art.png", "label.pdf", "label.art.pdf", "other.png"];
    expect(artFor("box.ai", files)).toBe("box.art.png");
    expect(artFor("label.pdf", files)).toBe("label.art.pdf");
    expect(artFor("lonely.pdf", files)).toBeUndefined();
  });
});

describe("packform build", () => {
  async function setup() {
    const root = await project();
    await initProject(root);
    const cfg = await readJson(path.join(root, "packform.config.json"));
    cfg.defaults = { dpi: 36 };
    cfg.files = { "Water Label.pdf": { shape: "amber", diameter: 60 } };
    await writeFile(path.join(root, "packform.config.json"), JSON.stringify(cfg));
    await copyFile(fixture("sleeve.pdf"), path.join(root, "dielines/sleeve.pdf"));
    await copyFile(fixture("bottle-label.pdf"), path.join(root, "dielines/Water Label.pdf"));
    // separate artwork for the label: a plain red image on the same artboard
    await sharp({ create: { width: 600, height: 300, channels: 3, background: "#d02020" } }).png().toFile(path.join(root, "dielines/Water Label.art.png"));
    return root;
  }
  const manifestOf = (root: string): Promise<Manifest> => readJson(path.join(root, "public/packform/manifest.json"));

  it("converts every dieline and writes a manifest with public URLs", async () => {
    const root = await setup();
    const r = await buildProject(root);
    expect(r.built.sort()).toEqual(["Water Label.pdf", "sleeve.pdf"]);
    const m = await manifestOf(root);
    expect(Object.keys(m.models).sort()).toEqual(["sleeve", "water-label"]);
    expect(m.models.sleeve).toMatchObject({ file: "sleeve.glb", url: "/packform/sleeve.glb", kind: "carton" });
    expect(m.models["water-label"]).toMatchObject({ url: "/packform/water-label.glb", kind: "label", art: "Water Label.art.png" });
    expect(existsSync(path.join(root, "public/packform/sleeve.glb"))).toBe(true);
  });

  it("applies per-file options from the config", async () => {
    const root = await setup();
    await buildProject(root);
    const doc = await new NodeIO().read(path.join(root, "public/packform/water-label.glb"));
    const body = doc.getRoot().listMeshes().find((m) => m.getName() === "body")!.listPrimitives()[0].getAttribute("POSITION")!;
    expect((body.getMaxNormalized([])[0] - body.getMinNormalized([])[0]) * 1000).toBeCloseTo(60, 0); // diameter 60 mm
  });

  it("skips unchanged files, rebuilds changed ones, and --force rebuilds all", async () => {
    const root = await setup();
    await buildProject(root);
    const again = await buildProject(root);
    expect(again.built).toEqual([]);
    expect(again.skipped).toHaveLength(2);
    // change only the label's artwork
    await sharp({ create: { width: 600, height: 300, channels: 3, background: "#2020d0" } }).png().toFile(path.join(root, "dielines/Water Label.art.png"));
    expect((await buildProject(root)).built).toEqual(["Water Label.pdf"]);
    expect((await buildProject(root, { force: true })).built).toHaveLength(2);
  });

  it("removes the model when its dieline is deleted, and leaves other files alone", async () => {
    const root = await setup();
    await writeFile(path.join(root, "public/packform/hand-made.glb"), "not ours");
    await buildProject(root);
    await rm(path.join(root, "dielines/sleeve.pdf"));
    const r = await buildProject(root);
    expect(r.removed).toEqual(["sleeve.pdf"]);
    expect(existsSync(path.join(root, "public/packform/sleeve.glb"))).toBe(false);
    expect(existsSync(path.join(root, "public/packform/hand-made.glb"))).toBe(true);
    expect(Object.keys((await manifestOf(root)).models)).toEqual(["water-label"]);
  });

  it("reports files it can't convert and keeps going", async () => {
    const root = await setup();
    await writeFile(path.join(root, "dielines/broken.pdf"), "not a pdf");
    const r = await buildProject(root);
    expect(r.failed.map((f) => f.file)).toEqual(["broken.pdf"]);
    expect(r.built).toHaveLength(2);
  });

  it("asks for init when there is no input folder", async () => {
    const root = await project();
    await expect(buildProject(root)).rejects.toThrow(/packform init/);
  });
});

describe("packform watch", () => {
  it("builds new dielines as they land and removes deleted ones", async () => {
    const root = await project();
    await initProject(root);
    await writeFile(path.join(root, "packform.config.json"), JSON.stringify({ input: "dielines", output: "public/packform", defaults: { dpi: 36 } }));
    const w = await watchProject(root, { delay: 100 });
    try {
      await w.idle();
      await copyFile(fixture("sleeve.pdf"), path.join(root, "dielines/sleeve.pdf"));
      await w.idle();
      expect(existsSync(path.join(root, "public/packform/sleeve.glb"))).toBe(true);
      await rm(path.join(root, "dielines/sleeve.pdf"));
      await w.idle();
      expect(existsSync(path.join(root, "public/packform/sleeve.glb"))).toBe(false);
    } finally {
      w.close();
    }
  }, 30000);
});
