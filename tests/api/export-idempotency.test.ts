import { afterEach, describe, expect, it } from "vitest";
import type { BundleExportResult } from "../../src/application/results.js";
import { buildApiServer } from "../../src/api/server.js";
import {
  createCompletedRun,
  disposeApplicationRoots,
  makeApplication
} from "../application/helpers.js";

afterEach(disposeApplicationRoots);

describe("REST bundle export idempotency", () => {
  it("replays the original candidate response after the selected revision stops being head", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const app = await buildApiServer({ service });
    const idempotencyKey = "rest-candidate-exact-replay";
    const request = () => app.inject({
      method: "POST",
      url: `/api/v1/revisions/${completed.headRevision!.id}/exports/candidate`,
      headers: {
        host: "localhost:8765",
        origin: "http://localhost:8765",
        "idempotency-key": idempotencyKey
      },
      payload: { expectedRevision: completed.run.revision }
    });

    try {
      const first = await request();
      expect(first.statusCode).toBe(200);
      const firstResult = first.json().result as BundleExportResult;
      const afterExport = await service.getRunStatus({ runId: completed.run.id });
      await service.generateBringupPlan({
        revisionId: completed.headRevision!.id,
        expectedRevision: afterExport.run.revision,
        idempotencyKey: "rest-candidate-advance-head"
      });

      const replay = await request();
      expect(replay.statusCode).toBe(200);
      expect(replay.json().result).toStrictEqual(firstResult);

      const conflict = await app.inject({
        method: "POST",
        url: "/api/v1/revisions/revision_does_not_exist/exports/candidate",
        headers: {
          host: "localhost:8765",
          origin: "http://localhost:8765",
          "idempotency-key": idempotencyKey
        },
        payload: { expectedRevision: completed.run.revision }
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({
        ok: false,
        error: { code: "IDEMPOTENCY_CONFLICT" }
      });
    } finally {
      await app.close();
    }
  });
});
