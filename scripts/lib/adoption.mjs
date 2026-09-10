import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateProfile } from "./config.mjs";
import { digest } from './ci.mjs';

const MANAGED_ROOTS = [
  ".github/ISSUE_TEMPLATE",
  ".github/pull_request_template.md",
  ".github/workflows/reusable-quality.yml",
  ".agents/pipeliner-policy.html",
  ".agents/skills",
  ".claude/skills",
  "AGENTS.md",
  "blueprints",
  "CLAUDE.md",
  "GEMINI.md",
  "schema",
  "scripts/audit-project.mjs",
  "scripts/evaluate-qa.mjs",
  "scripts/lib",
  "scripts/validate-repository.mjs",
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
  const details = await lstat(absolutePath);
  if (details.isSymbolicLink()) throw new Error(`refusing managed source symlink: ${relativePath}`);
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

async function assertSafeDestination(root, destination) {
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe adoption destination');
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`refusing destination symlink: ${current}`); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}

function entry(relativePath, targetRoot, content, sourcePath = null) {
  return {
    relativePath: relativePath.split(path.sep).join("/"),
    sourcePath,
    targetPath: path.join(targetRoot, relativePath),
    content,
  };
}

export async function planAdoption({ sourceRoot, targetRoot, profile, reconciliation }) {
  validateProfile(profile);
  const source = await realpath(sourceRoot);
  const target = await realpath(targetRoot);
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

  if (reconciliation && (reconciliation.version !== 1 || !reconciliation.files)) throw new Error('invalid reconciliation manifest');
  const plan = { sourceRoot: source, targetRoot: target, create: [], identical: [], reconciled: [], conflicts: [] };
  for (const candidate of candidates) {
    await assertSafeDestination(target, candidate.targetPath);
    if (!(await exists(candidate.targetPath))) {
      plan.create.push(candidate);
      continue;
    }
    const current = await readFile(candidate.targetPath);
    if (current.equals(candidate.content)) plan.identical.push(candidate);
    else {
      const review = reconciliation?.files[candidate.relativePath];
      if (review?.sourceSha256 === digest(candidate.content) && review.targetSha256 === digest(current) && typeof review.rationale === 'string' && review.rationale.trim()) {
        plan.reconciled.push({ ...candidate, content: current });
      } else plan.conflicts.push(candidate);
    }
  }
  return plan;
}

export async function applyAdoptionPlan(plan) {
  if (plan.conflicts.length > 0) {
    const paths = plan.conflicts.map((item) => item.relativePath).join(", ");
    throw new Error(`refusing to overwrite existing files: ${paths}`);
  }

  let created = 0;
  if (await realpath(plan.targetRoot) !== plan.targetRoot) throw new Error('adoption root changed after planning');
  for (const item of [...plan.create, ...plan.identical, ...(plan.reconciled ?? [])]) await assertSafeDestination(plan.targetRoot, item.targetPath);
  for (const item of [...plan.identical, ...(plan.reconciled ?? [])]) {
    if (!(await readFile(item.targetPath)).equals(item.content)) throw new Error(`file changed after planning: ${item.relativePath}`);
  }
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
