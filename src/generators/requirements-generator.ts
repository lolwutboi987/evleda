import { parseRequirements } from "../core/requirements.js";
import type { StageExecutor } from "../workflow/contracts.js";
import {
  blockerDraft,
  evidenceDraft,
  finalizeStageResult,
  GENERATOR_TOOL,
  jsonArtifactDraft,
  artifactDraft
} from "./draft-utils.js";

const reviewMarkdown = (
  parsed: ReturnType<typeof parseRequirements>
): string => {
  const requirementLines = parsed.document.requirements.map(
    (requirement) =>
      `- [ ] ${requirement.id}: ${requirement.statement} Acceptance: ${requirement.acceptanceCriteria}`
  );
  const assumptionLines = parsed.document.unresolvedAssumptions.map(
    (assumption) => `- ${assumption.severity.toUpperCase()} ${assumption.id}: ${assumption.statement}`
  );
  return [
    "# Requirements review",
    "",
    "Lifecycle: CANDIDATE — NOT QUALIFIED OR RELEASED",
    `Requirements digest: ${parsed.document.identity.digest}`,
    "",
    "## Requirements",
    "",
    ...(requirementLines.length === 0 ? ["- No requirements parsed."] : requirementLines),
    "",
    "## Unresolved assumptions",
    "",
    ...(assumptionLines.length === 0 ? ["- None."] : assumptionLines),
    "",
    "A human requirements reviewer must approve this exact digest before architecture work begins.",
    ""
  ].join("\n");
};

export const requirementsStageExecutor: StageExecutor<"requirements"> = {
  stage: "requirements",
  async execute(context) {
    const parsed = parseRequirements(context.prompt);
    const exactInputs = [parsed.document.sourcePrompt];
    const status = parsed.blocking.length === 0 ? "pass" : "fail";
    const artifacts = [
      jsonArtifactDraft({
        logicalName: "requirements/requirements.json",
        value: parsed.document,
        exactInputs,
        validationStatus: status,
        unresolvedAssumptions: parsed.document.unresolvedAssumptions
      }),
      artifactDraft({
        logicalName: "requirements/review.md",
        mediaType: "text/markdown",
        content: reviewMarkdown(parsed),
        exactInputs,
        derivedFrom: ["requirements/requirements.json"],
        validationStatus: status,
        unresolvedAssumptions: parsed.document.unresolvedAssumptions
      })
    ];
    const blockers = parsed.blocking.map((assumption) =>
      blockerDraft(
        assumption.id.toUpperCase(),
        assumption.statement,
        exactInputs,
        "Revise the prompt to remove this ambiguity, regenerate requirements, and obtain approval."
      )
    );
    const evidence = [
      evidenceDraft({
        evidenceClass: "evleda_check",
        claim:
          parsed.blocking.length === 0
            ? "The deterministic parser extracted an internally supported v0 requirements envelope; this is not electrical qualification."
            : "The deterministic parser found blocking ambiguity or an unsupported v0 requirement.",
        subjectDigests: artifacts.map((artifact) => artifact.identity.digest),
        parsedArtifactLogicalName: "requirements/requirements.json",
        exactInputs,
        tool: GENERATOR_TOOL,
        validationStatus: status,
        unresolvedAssumptions: parsed.document.unresolvedAssumptions
      })
    ];
    return finalizeStageResult(
      "requirements",
      artifacts,
      evidence,
      blockers,
      parsed.document
    );
  }
};
