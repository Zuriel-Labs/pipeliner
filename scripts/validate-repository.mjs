#!/usr/bin/env node

import path from "node:path";

import { validateRepository } from "./lib/validation.mjs";

const root = path.resolve(process.argv[2] ?? ".");
const errors = await validateRepository(root);

if (errors.length > 0) {
  console.error(`Pipeliner repository validation failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("Pipeliner repository validation OK.");
}
