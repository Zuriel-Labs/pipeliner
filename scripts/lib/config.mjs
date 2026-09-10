import { readFile } from "node:fs/promises";
import { validateQA } from "./qa.mjs";

const RELEASE_STRATEGIES = new Set([
  "none",
  "immutable-promotion",
  "direct-production",
  "multi-environment",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, field) {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  return value;
}

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new Error(`${field} must be a ${allowEmpty ? "string" : "non-empty string"}`);
  }
  return value;
}

function requireStringArray(value, field, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new Error(`${field} must contain at least ${minimum} value${minimum === 1 ? "" : "s"}`);
  }
  value.forEach((item, index) => requireString(item, `${field}[${index}]`));
  if (new Set(value).size !== value.length) throw new Error(`${field} must not contain duplicates`);
  return value;
}

function validateProjectField(value, field) {
  const object = requireObject(value, field);
  requireString(object.name, `${field}.name`);
  requireStringArray(object.options, `${field}.options`, 1);
}

function validateEnvironment(environment, index) {
  const field = `release.environments[${index}]`;
  const object = requireObject(environment, field);
  requireString(object.name, `${field}.name`);
  if (!["review", "production", "native"].includes(object.role)) {
    throw new Error(`${field}.role must be review, production, or native`);
  }
  requireString(object.buildCommand, `${field}.buildCommand`, { allowEmpty: true });
  requireString(object.deployCommand, `${field}.deployCommand`, { allowEmpty: true });
  requireString(object.verifyCommand, `${field}.verifyCommand`);
  if (object.url !== undefined) requireString(object.url, `${field}.url`, { allowEmpty: true });
  if (object.platform !== undefined) requireString(object.platform, `${field}.platform`);
  if (object.approvalPhrase !== undefined) {
    requireString(object.approvalPhrase, `${field}.approvalPhrase`, { allowEmpty: true });
  }
  if (object.promoteWithoutRebuild !== undefined && typeof object.promoteWithoutRebuild !== "boolean") {
    throw new Error(`${field}.promoteWithoutRebuild must be a boolean`);
  }
}

export function validateProfile(profile) {
  const root = requireObject(profile, "profile");
  if (root.qa !== undefined) validateQA(root.qa);
  if (root.version !== 1) throw new Error("version must equal 1");

  const repository = requireObject(root.repository, "repository");
  for (const field of ["owner", "name", "defaultBranch", "projectManager"]) {
    requireString(repository[field], `repository.${field}`);
  }

  const project = requireObject(root.project, "project");
  requireString(project.owner, "project.owner");
  if (!Number.isInteger(project.number) || project.number < 0) {
    throw new Error("project.number must be a non-negative integer");
  }
  requireString(project.title, "project.title");
  requireString(project.statusField, "project.statusField");
  const statuses = requireObject(project.statuses, "project.statuses");
  const statusValues = ["backlog", "onHold", "inProgress", "inReview", "done"].map((name) =>
    requireString(statuses[name], `project.statuses.${name}`),
  );
  if (new Set(statusValues).size !== statusValues.length) {
    throw new Error("project.statuses values must be unique");
  }
  const metadataFields = requireObject(project.metadataFields, "project.metadataFields");
  for (const field of ["priority", "impact", "effort"]) {
    validateProjectField(metadataFields[field], `project.metadataFields.${field}`);
  }

  const workflow = requireObject(root.workflow, "workflow");
  if (workflow.branchProtection !== undefined && !['enabled', 'disabled'].includes(workflow.branchProtection)) {
    throw new Error('workflow.branchProtection must be enabled or disabled; omit for PM discovery');
  }
  if (workflow.maxActiveIssues !== 1) throw new Error("workflow.maxActiveIssues must equal 1");
  requireString(workflow.branchPattern, "workflow.branchPattern");
  requireString(workflow.issueReference, "workflow.issueReference");
  const approvals = requireObject(workflow.approvalPhrases, "workflow.approvalPhrases");
  for (const field of ["issueCreation", "production", "completion", "nativeCandidate"]) {
    requireString(approvals[field], `workflow.approvalPhrases.${field}`);
  }
  const pmTesting = requireObject(workflow.pmTesting, "workflow.pmTesting");
  if (pmTesting.required !== true) throw new Error("workflow.pmTesting.required must be true");
  requireStringArray(pmTesting.terms, "workflow.pmTesting.terms", 2);
  for (const term of ["Project Manager QA", "PM Testing"]) {
    if (!pmTesting.terms.includes(term)) throw new Error(`workflow.pmTesting.terms must include ${term}`);
  }
  requireStringArray(pmTesting.requiredSections, "workflow.pmTesting.requiredSections", 5);

  const quality = requireObject(root.quality, "quality");
  requireStringArray(quality.commands, "quality.commands", 1);
  requireStringArray(quality.requiredChecks, "quality.requiredChecks");

  const release = requireObject(root.release, "release");
  if (!RELEASE_STRATEGIES.has(release.strategy)) {
    throw new Error(`release.strategy must be one of ${[...RELEASE_STRATEGIES].join(", ")}`);
  }
  requireStringArray(release.candidateIdentity, "release.candidateIdentity", 2);
  if (!Array.isArray(release.environments)) throw new Error("release.environments must be an array");
  release.environments.forEach(validateEnvironment);

  if (release.strategy === "none" && release.environments.length !== 0) {
    throw new Error("release.strategy none requires no release.environments");
  }
  if (release.strategy === "immutable-promotion") {
    const review = release.environments.some((environment) => environment.role === "review");
    const production = release.environments.find((environment) => environment.role === "production");
    if (!review || !production || production.promoteWithoutRebuild !== true) {
      throw new Error(
        "immutable-promotion requires review and production environments with Production promoteWithoutRebuild true",
      );
    }
  }
  if (
    release.strategy === "direct-production" &&
    !release.environments.some((environment) => environment.role === "production")
  ) {
    throw new Error("direct-production requires a production environment");
  }
  if (release.strategy === "multi-environment" && release.environments.length < 2) {
    throw new Error("multi-environment requires at least two environments");
  }

  return profile;
}

export async function loadProfile(profilePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(profilePath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read profile ${profilePath}: ${error.message}`, { cause: error });
  }
  return validateProfile(parsed);
}
