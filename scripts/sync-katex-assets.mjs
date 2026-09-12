import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(process.argv[2] ?? join(projectRoot, "node_modules", "katex"));
const sourceDist = join(packageRoot, "dist");
const targetDist = join(projectRoot, "dashboard", "vendor", "katex");
const targetFonts = join(targetDist, "fonts");

await mkdir(targetFonts, { recursive: true });
await copyFile(join(sourceDist, "katex.min.js"), join(targetDist, "katex.min.js"));
await copyFile(join(sourceDist, "katex.min.css"), join(targetDist, "katex.min.css"));
await copyFile(join(packageRoot, "LICENSE"), join(targetDist, "LICENSE"));

const fonts = (await readdir(join(sourceDist, "fonts"))).filter((name) => name.endsWith(".woff2"));
for (const font of fonts) {
  await copyFile(join(sourceDist, "fonts", font), join(targetFonts, font));
}

console.log(JSON.stringify({ targetDist, fonts: fonts.length }, null, 2));
