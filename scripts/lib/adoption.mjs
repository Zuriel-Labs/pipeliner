import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateProfile } from "./config.mjs";

const MANAGED_ROOTS = [
  ".agents/pipeliner-policy.html",
  ".agents/skills",
  ".claude/skills",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
];

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!(await exists(absolutePath))) return [];
  const details = await stat(absolutePath);
  if (details.isFile()) return [relativePath];
  if (!details.isDirectory()) return [];

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => listFiles(root, path.join(relativePath, entry.name))),
  );
  return nested.flat();
}

function entry(relativePath, targetRoot, content, sourcePath = null) {
  return {
    relativePath: relativePath.split(path.sep).join("/"),
    sourcePath,
    targetPath: path.join(targetRoot, relativePath),
    content,
  };
}

export async function planAdoption({ sourceRoot, targetRoot, profile }) {
  validateProfile(profile);
  const source = path.resolve(sourceRoot);
  const target = path.resolve(targetRoot);
  if (!(await exists(source))) throw new Error(`source root does not exist: ${source}`);
  if (!(await exists(target))) throw new Error(`target root does not exist: ${target}`);

  const managedFiles = (
    await Promise.all(MANAGED_ROOTS.map((relativePath) => listFiles(source, relativePath)))
  )
    .flat()
    .sort();

  const candidates = await Promise.all(
    managedFiles.map(async (relativePath) => {
      const sourcePath = path.join(source, relativePath);
      return entry(relativePath, target, await readFile(sourcePath), sourcePath);
    }),
  );
  candidates.push(
    entry("pipeliner.config.json", target, Buffer.from(`${JSON.stringify(profile, null, 2)}\n`)),
  );
  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const plan = { sourceRoot: source, targetRoot: target, create: [], identical: [], conflicts: [] };
  for (const candidate of candidates) {
    if (!(await exists(candidate.targetPath))) {
      plan.create.push(candidate);
      continue;
    }
    const current = await readFile(candidate.targetPath);
    if (current.equals(candidate.content)) plan.identical.push(candidate);
    else plan.conflicts.push(candidate);
  }
  return plan;
}

export async function applyAdoptionPlan(plan) {
  if (plan.conflicts.length > 0) {
    const paths = plan.conflicts.map((item) => item.relativePath).join(", ");
    throw new Error(`refusing to overwrite existing files: ${paths}`);
  }

  let created = 0;
  for (const item of plan.create) {
    await mkdir(path.dirname(item.targetPath), { recursive: true });
    try {
      await writeFile(item.targetPath, item.content, { flag: "wx" });
      created += 1;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const current = await readFile(item.targetPath);
      if (!current.equals(item.content)) {
        throw new Error(`refusing to overwrite file created after planning: ${item.relativePath}`);
      }
    }
  }
  return { created, identical: plan.identical.length + plan.create.length - created };
}
