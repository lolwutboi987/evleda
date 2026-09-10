import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import {
  UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA,
  type StageExecutionResult,
  type UpstreamStageSourceRevisionBinding
} from "../../src/workflow/contracts.js";

export const fixtureUpstreamSourceRevisionBinding = (options: {
  readonly projectId: string;
  readonly runId: string;
  readonly result: StageExecutionResult;
  readonly sourceRevisionId: string;
  readonly committedRevisionId: string;
  readonly attemptId?: string;
}): UpstreamStageSourceRevisionBinding => {
  if (options.result.stage === "requirements") {
    throw new Error("Requirements do not have candidate-stage source-revision bindings");
  }
  const stage = options.result.stage;
  const stageInputManifest = canonicalIdentity(
    {
      projectId: options.projectId,
      runId: options.runId,
      stage,
      sourceRevisionId: options.sourceRevisionId
    },
    `evleda.stage-input.${stage}.v1`
  );
  const provisionPreimage = {
    projectId: options.projectId,
    runId: options.runId,
    stage,
    sourceRevisionId: options.sourceRevisionId
  };
  const provisionBytes = Buffer.from(`${canonicalJson(provisionPreimage)}\n`, "utf8");
  const payload = {
    schemaVersion: UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA,
    projectId: options.projectId,
    runId: options.runId,
    stage,
    attemptId: options.attemptId ?? `attempt_fixture_${stage}`,
    stageInputManifest,
    stageOutputIdentity: options.result.outputIdentity,
    provisionIdentity: canonicalIdentity(provisionPreimage, "evleda.stage-provision.v1"),
    provisionManifestBlob: contentIdentity(provisionBytes),
    sourceRevision: {
      id: options.sourceRevisionId,
      manifest: canonicalIdentity(
        {
          projectId: options.projectId,
          runId: options.runId,
          revisionId: options.sourceRevisionId
        },
        "evleda.design-revision.v1"
      )
    },
    committedRevision: {
      id: options.committedRevisionId,
      manifest: canonicalIdentity(
        {
          projectId: options.projectId,
          runId: options.runId,
          revisionId: options.committedRevisionId
        },
        "evleda.design-revision.v1"
      )
    }
  } as const;
  return {
    ...payload,
    identity: canonicalIdentity(payload, UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA)
  };
};
