import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const OUT = "public/app";

await rm("public", { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const result = await Bun.build({
  entrypoints: ["web/main.tsx"],
  outdir: OUT,
  naming: "[name]-[hash].[ext]",
  minify: true,
  tsconfig: "web/tsconfig.json",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const script = result.outputs.find((output) => output.kind === "entry-point");
if (!script) throw new Error("Mini App bundle has no entry point");
const html = (await readFile("web/index.html", "utf8")).replace("%SCRIPT%", `./${basename(script.path)}`);
await writeFile(`${OUT}/index.html`, html);
console.log(`Mini App built into ${OUT}`);
