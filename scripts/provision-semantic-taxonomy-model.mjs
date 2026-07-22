import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const projectRoot = process.cwd();
const manifestPath = path.join(
  projectRoot,
  "model-manifests",
  "semantic-taxonomy-multilingual-e5-small.json"
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const modelDirectory = path.join(
  projectRoot,
  "public",
  "models",
  ...manifest.modelId.split("/")
);
const wasmDirectory = path.join(projectRoot, "public", "transformers-wasm");
const remoteRoot = `https://huggingface.co/${manifest.modelId}/resolve/${manifest.revision}`;

await mkdir(modelDirectory, { recursive: true });
await mkdir(wasmDirectory, { recursive: true });

for (const file of manifest.files) {
  const destination = path.join(modelDirectory, file.path);
  await mkdir(path.dirname(destination), { recursive: true });
  if (await verifies(destination, file)) {
    process.stdout.write(`verified ${file.path}\n`);
    continue;
  }

  const temporary = `${destination}.download`;
  await unlink(temporary).catch(() => undefined);
  const response = await fetch(`${remoteRoot}/${file.path}`);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${file.path}: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  if (!(await verifies(temporary, file))) {
    throw new Error(`Checksum mismatch for ${file.path}`);
  }
  await rename(temporary, destination);
  process.stdout.write(`downloaded ${file.path}\n`);
}

const wasmSourceDirectory = path.join(
  projectRoot,
  "node_modules",
  "@huggingface",
  "transformers",
  "node_modules",
  "onnxruntime-web",
  "dist"
);
for (const file of manifest.wasmFiles) {
  const source = path.join(wasmSourceDirectory, file.path);
  const destination = path.join(wasmDirectory, file.path);
  const spec = {
    size: file.size,
    algorithm: "sha256",
    checksum: file.sha256,
  };
  if (!(await verifies(source, spec))) {
    throw new Error(`Installed ONNX runtime does not match manifest: ${file.path}`);
  }
  await copyFile(source, destination);
  process.stdout.write(`copied ${file.path}\n`);
}

process.stdout.write(
  `Semantic taxonomy model ready at ${path.relative(projectRoot, modelDirectory)}\n`
);

async function verifies(filePath, spec) {
  const fileStat = await stat(filePath).catch(() => undefined);
  if (!fileStat || fileStat.size !== spec.size) return false;
  const hash = createHash(spec.algorithm === "git-sha1" ? "sha1" : "sha256");
  if (spec.algorithm === "git-sha1") {
    hash.update(`blob ${fileStat.size}\0`);
  }
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex") === spec.checksum;
}
