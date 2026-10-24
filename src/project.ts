import { createHash } from "node:crypto";
import { existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dielineToGlb, type DielineKind, type DielineOptions } from "./index";
import type { ContainerShape } from "./shapes";

/** Per-file options in `packform.config.json`. Pages are 1-based, like the CLI. */
export interface FileOptions {
  kind?: DielineKind;
  dpi?: number;
  quality?: number;
  linesPage?: number;
  artPage?: number;
  foldAngle?: number;
  animation?: boolean;
  boardColor?: string;
  shape?: ContainerShape;
  diameter?: number;
  height?: number;
  capColor?: string;
  bodyColor?: string;
  bodyOpacity?: number;
}

export interface ProjectConfig {
  /** Folder with dielines and artwork, relative to the project root. Default `dielines`. */
  input: string;
  /** Folder the `.glb` files are written to (inside the public folder). Default `<public>/packform`. */
  output: string;
  /** Options applied to every file. */
  defaults?: FileOptions;
  /** Options for single files, keyed by file name (e.g. `"label.pdf": { "shape": "amber" }`). */
  files?: Record<string, FileOptions>;
}

export const CONFIG_FILE = "packform.config.json";
const DIELINE_EXT = /\.(ai|pdf)$/i;
const ART_EXT = /\.art\.(png|jpe?g|webp|pdf)$/i;
const CACHE_FILE = ".packform-cache.json";

/** Where each framework serves static files from. */
const FRAMEWORKS: [dep: string, name: string, publicDir: string][] = [
  ["next", "Next.js", "public"],
  ["@sveltejs/kit", "SvelteKit", "static"],
  ["gatsby", "Gatsby", "static"],
  ["nuxt", "Nuxt", "public"],
  ["astro", "Astro", "public"],
  ["@remix-run/react", "Remix", "public"],
  ["@angular/core", "Angular", "public"],
  ["react-scripts", "Create React App", "public"],
  ["vite", "Vite", "public"],
];

export interface Framework {
  name: string;
  publicDir: string;
}

/** Work out the framework and its public (static files) folder from package.json. */
export async function detectFramework(root: string): Promise<Framework> {
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    // no package.json: fall through to the folder checks
  }
  for (const [dep, name, publicDir] of FRAMEWORKS) if (dep in deps) return { name, publicDir };
  if (!existsSync(path.join(root, "public")) && existsSync(path.join(root, "static"))) return { name: "unknown", publicDir: "static" };
  return { name: "unknown", publicDir: "public" };
}

export async function loadConfig(root: string): Promise<ProjectConfig> {
  const file = path.join(root, CONFIG_FILE);
  const { publicDir } = await detectFramework(root);
  const fallback: ProjectConfig = { input: "dielines", output: `${publicDir}/packform` };
  if (!existsSync(file)) return fallback;
  let cfg: Partial<ProjectConfig>;
  try {
    cfg = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  return { ...fallback, ...cfg };
}

export interface InitResult {
  framework: Framework;
  config: ProjectConfig;
  /** What was created or changed, for printing. */
  changes: string[];
}

/**
 * Set a project up for packform: create the input and output folders, keep the dielines out of git,
 * write `packform.config.json` and add a `packform` npm script. Safe to run again: nothing is overwritten.
 */
export async function initProject(root: string): Promise<InitResult> {
  const framework = await detectFramework(root);
  const changes: string[] = [];
  const configPath = path.join(root, CONFIG_FILE);
  let config: ProjectConfig;
  if (existsSync(configPath)) {
    config = await loadConfig(root);
  } else {
    config = { input: "dielines", output: `${framework.publicDir}/packform`, defaults: { dpi: 300 }, files: {} };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    changes.push(`created ${CONFIG_FILE}`);
  }

  for (const dir of [config.input, config.output]) {
    if (!existsSync(path.join(root, dir))) {
      await mkdir(path.join(root, dir), { recursive: true });
      changes.push(`created ${dir}/`);
    }
  }

  // Dielines and artwork are print sources: keep them out of git (the generated .glb files are committed)
  const gitignore = path.join(root, ".gitignore");
  const current = existsSync(gitignore) ? await readFile(gitignore, "utf8") : "";
  const entry = `/${config.input.replace(/^\/+|\/+$/g, "")}/`;
  const ignored = current.split(/\r?\n/).some((l) => [entry, entry.slice(1), entry.slice(0, -1), entry.slice(1, -1)].includes(l.trim()));
  if (!ignored) {
    const block = `${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}# packform: dieline and artwork sources (stay on your machine; the generated .glb files are committed)\n${entry}\n`;
    await writeFile(gitignore, current + block);
    changes.push(`added ${entry} to .gitignore`);
  }

  // npm script
  const pkgPath = path.join(root, "package.json");
  if (existsSync(pkgPath)) {
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    if (!pkg.scripts?.packform) {
      pkg.scripts = { ...pkg.scripts, packform: "packform build" };
      const indent = raw.match(/^[ \t]+/m)?.[0] ?? "  ";
      await writeFile(pkgPath, JSON.stringify(pkg, null, indent) + "\n");
      changes.push(`added "packform": "packform build" to package.json scripts`);
    }
  }
  return { framework, config, changes };
}

/** The model name for a dieline file: its file name, made URL-safe (`Medicine Box 50×50.ai` → `medicine-box-50x50`). */
export function modelName(file: string): string {
  return (
    path
      .basename(file)
      .replace(DIELINE_EXT, "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/×/g, "x")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "model"
  );
}

/** Find the separate artwork for a dieline: `name.art.png` (or .jpg, .jpeg, .webp, .pdf) next to `name.ai`. */
export function artFor(dieline: string, files: string[]): string | undefined {
  const base = path.basename(dieline).replace(DIELINE_EXT, "").toLowerCase();
  return files.find((f) => ART_EXT.test(f) && f.toLowerCase().replace(ART_EXT, "") === base);
}

function toDielineOptions(o: FileOptions, art?: string): DielineOptions {
  return {
    kind: o.kind,
    dpi: o.dpi,
    quality: o.quality,
    linesPage: o.linesPage !== undefined ? o.linesPage - 1 : undefined,
    artPage: o.artPage !== undefined ? o.artPage - 1 : undefined,
    foldAngle: o.foldAngle,
    art,
    carton: { animation: o.animation, boardColor: o.boardColor },
    container: { shape: o.shape, diameter: o.diameter, height: o.height, capColor: o.capColor, bodyColor: o.bodyColor, bodyOpacity: o.bodyOpacity },
  };
}

export interface ManifestEntry {
  /** Output file name, inside the output folder. */
  file: string;
  /** URL the site serves it from (when the output is inside the public folder). */
  url: string;
  /** Source dieline (and artwork) file names. */
  source: string;
  art?: string;
  kind: string;
  /** Real size in millimetres. */
  size: Record<string, number>;
}

export interface Manifest {
  generator: string;
  models: Record<string, ManifestEntry>;
}

export interface BuildReport {
  built: string[];
  skipped: string[];
  removed: string[];
  failed: { file: string; error: string }[];
  manifest: Manifest;
}

interface Cache {
  version: string;
  entries: Record<string, { hash: string; output: string; entry: ManifestEntry }>;
}

async function packageVersion(): Promise<string> {
  // dist/ and src/ both sit one level below the package root
  for (const p of [new URL("../package.json", import.meta.url), new URL("../../package.json", import.meta.url)]) {
    try {
      const pkg = JSON.parse(await readFile(p, "utf8"));
      if (pkg.name === "packform") return pkg.version;
    } catch {
      // try the next location
    }
  }
  return "0.0.0";
}

/**
 * Convert every dieline in the input folder into a `.glb` in the output folder, and write `manifest.json`.
 * Files whose dieline, artwork and options haven't changed since the last build are skipped.
 * Models whose dieline was deleted are removed (only files packform created are ever deleted).
 */
export async function buildProject(root: string, opts: { force?: boolean; log?: (line: string) => void } = {}): Promise<BuildReport> {
  const log = opts.log ?? (() => {});
  const config = await loadConfig(root);
  const { publicDir } = await detectFramework(root);
  const inputDir = path.join(root, config.input);
  const outputDir = path.join(root, config.output);
  if (!existsSync(inputDir)) throw new Error(`No ${config.input}/ folder. Run \`packform init\` first, or set "input" in ${CONFIG_FILE}.`);
  await mkdir(outputDir, { recursive: true });

  const version = await packageVersion();
  const cachePath = path.join(inputDir, CACHE_FILE);
  let cache: Cache = { version, entries: {} };
  try {
    const c = JSON.parse(await readFile(cachePath, "utf8"));
    if (c.version === version) cache = c;
  } catch {
    // no cache yet
  }

  const files = (await readdir(inputDir)).filter((f) => !f.startsWith("."));
  const dielines = files.filter((f) => DIELINE_EXT.test(f) && !ART_EXT.test(f)).sort();
  // URL prefix: the output folder's path below the public folder
  const relToPublic = path.relative(path.join(root, publicDir), outputDir);
  const urlBase = relToPublic.startsWith("..") ? "" : "/" + relToPublic.split(path.sep).join("/");

  const report: BuildReport = { built: [], skipped: [], removed: [], failed: [], manifest: { generator: `packform@${version}`, models: {} } };
  const next: Cache = { version, entries: {} };
  const taken = new Map<string, string>();

  for (const file of dielines) {
    const name = modelName(file);
    if (taken.has(name)) {
      report.failed.push({ file, error: `same model name "${name}" as ${taken.get(name)}; rename one of them` });
      continue;
    }
    taken.set(name, file);
    const art = artFor(file, files);
    const options: FileOptions = { ...config.defaults, ...config.files?.[file] };
    const output = `${name}.glb`;
    try {
      const bytes = await readFile(path.join(inputDir, file));
      const artBytes = art ? await readFile(path.join(inputDir, art)) : undefined;
      const hash = createHash("sha256").update(bytes).update(artBytes ?? "").update(JSON.stringify(options)).digest("hex");
      const prev = cache.entries[file];
      if (!opts.force && prev && prev.hash === hash && prev.output === output && existsSync(path.join(outputDir, output))) {
        next.entries[file] = prev;
        report.manifest.models[name] = prev.entry;
        report.skipped.push(file);
        continue;
      }
      const { glb, layout } = await dielineToGlb(new Uint8Array(bytes), toDielineOptions(options, art ? path.join(inputDir, art) : undefined));
      await writeFile(path.join(outputDir, output), glb);
      const entry: ManifestEntry = {
        file: output,
        url: `${urlBase}/${output}`,
        source: file,
        ...(art ? { art } : {}),
        kind: layout.kind,
        size: layout.size as Record<string, number>,
      };
      next.entries[file] = { hash, output, entry };
      report.manifest.models[name] = entry;
      report.built.push(file);
      log(`✔ ${file}${art ? ` + ${art}` : ""} → ${path.join(config.output, output)} (${layout.kind}, ${(glb.byteLength / 1024).toFixed(0)} KB)`);
    } catch (err) {
      report.failed.push({ file, error: (err as Error).message.split("\n")[0] });
      log(`✖ ${file}: ${(err as Error).message.split("\n")[0]}`);
      // keep the previous model (if any) rather than leaving a gap
      if (cache.entries[file]) {
        next.entries[file] = cache.entries[file];
        report.manifest.models[name] = cache.entries[file].entry;
      }
    }
  }

  // Remove models whose dieline is gone (only outputs packform recorded as its own)
  for (const [file, prev] of Object.entries(cache.entries)) {
    if (next.entries[file]) continue;
    if (Object.values(next.entries).some((e) => e.output === prev.output)) continue;
    await rm(path.join(outputDir, prev.output), { force: true });
    report.removed.push(file);
    log(`– ${file} removed → deleted ${path.join(config.output, prev.output)}`);
  }

  await writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(report.manifest, null, 2) + "\n");
  await writeFile(cachePath, JSON.stringify(next, null, 2) + "\n");
  return report;
}

export interface Watcher {
  close(): void;
  /** Resolves when the current (or next queued) build has finished. */
  idle(): Promise<void>;
}

/**
 * Build once, then rebuild whenever a dieline, artwork file or the config changes.
 * Waits for files to stop changing size first, so large files still being copied aren't read half-written.
 */
export async function watchProject(root: string, opts: { log?: (line: string) => void; delay?: number } = {}): Promise<Watcher> {
  const log = opts.log ?? (() => {});
  const delay = opts.delay ?? 400;
  const config = await loadConfig(root);
  const inputDir = path.join(root, config.input);
  let running: Promise<void> = Promise.resolve();
  let queued = false;
  let timer: NodeJS.Timeout | undefined;

  const settled = async () => {
    // wait until no file in the folder is still growing
    for (let i = 0; i < 50; i++) {
      const sizes = async () => {
        const out: Record<string, number> = {};
        for (const f of await readdir(inputDir).catch(() => [] as string[])) {
          try {
            out[f] = (await stat(path.join(inputDir, f))).size;
          } catch {
            // deleted meanwhile
          }
        }
        return JSON.stringify(out);
      };
      const a = await sizes();
      await new Promise((r) => setTimeout(r, 150));
      if (a === (await sizes())) return;
    }
  };

  const run = () => {
    if (queued) return;
    queued = true;
    running = running.then(async () => {
      queued = false;
      await settled();
      try {
        const r = await buildProject(root, { log });
        if (!r.built.length && !r.removed.length && !r.failed.length) log("· up to date");
      } catch (err) {
        log(`✖ ${(err as Error).message}`);
      }
    });
  };
  const schedule = (file: string | null) => {
    if (file && (file.startsWith(".") || file === CACHE_FILE)) return;
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  };

  run();
  const watchers: FSWatcher[] = [fsWatch(inputDir, (_e, f) => schedule(f?.toString() ?? null))];
  watchers.push(fsWatch(root, (_e, f) => f?.toString() === CONFIG_FILE && schedule(CONFIG_FILE)));
  log(`watching ${config.input}/ → ${config.output}/ (Ctrl+C to stop)`);
  return {
    close: () => {
      clearTimeout(timer);
      watchers.forEach((w) => w.close());
    },
    idle: async () => {
      // let any pending debounce fire, then wait for the chain to drain
      await new Promise((r) => setTimeout(r, delay + 50));
      let current: Promise<void>;
      do {
        current = running;
        await current;
      } while (current !== running);
    },
  };
}
