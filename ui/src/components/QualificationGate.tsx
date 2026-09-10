import { CheckSquare } from "@phosphor-icons/react/dist/csr/CheckSquare";
import { LockKey } from "@phosphor-icons/react/dist/csr/LockKey";
import { UserCheck } from "@phosphor-icons/react/dist/csr/UserCheck";
import { useEffect, useRef, useState } from "react";
import type { QualificationInput } from "../model";
import { shortDigest } from "../model";

interface QualificationErrors {
  readonly scope?: string;
  readonly rationale?: string;
  readonly capabilityToken?: string;
  readonly acknowledgement?: string;
}

interface QualificationGateProps {
  readonly ready: boolean;
  readonly qualified: boolean;
  readonly exportEnabled: boolean;
  readonly busy: boolean;
  readonly revisionDigest?: string | undefined;
  readonly requirementsDigest?: string | undefined;
  readonly evidenceRootDigest?: string | undefined;
  readonly onQualify: (input: QualificationInput) => Promise<void>;
}

const validate = (
  scope: string,
  rationale: string,
  capabilityToken: string,
  acknowledged: boolean
): QualificationErrors => {
  const errors: {
    scope?: string;
    rationale?: string;
    capabilityToken?: string;
    acknowledgement?: string;
  } = {};
  if (scope.trim().length < 10) errors.scope = "Describe the controlled prototype scope.";
  if (rationale.trim().length < 20) {
    errors.rationale = "Record the evidence and physical review rationale in at least 20 characters.";
  }
  if (capabilityToken.length === 0) {
    errors.capabilityToken = "Enter the role-scoped hardware qualification credential.";
  }
  if (!acknowledged) {
    errors.acknowledgement = "Confirm that qualification is exact and is not manufacturing release.";
  }
  return errors;
};

export function QualificationGate({
  ready,
  qualified,
  exportEnabled,
  busy,
  revisionDigest,
  requirementsDigest,
  evidenceRootDigest,
  onQualify
}: QualificationGateProps) {
  const [scope, setScope] = useState("One controlled prototype build of this exact revision");
  const [rationale, setRationale] = useState("");
  const [capabilityToken, setCapabilityToken] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [opened, setOpened] = useState(false);
  const [errors, setErrors] = useState<QualificationErrors>({});
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (Object.keys(errors).length > 0) errorRef.current?.focus();
  }, [errors]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validate(
      scope,
      rationale,
      capabilityToken,
      acknowledged
    );
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    try {
      await onQualify({
        scope: scope.trim(),
        rationale: rationale.trim(),
        capabilityToken
      });
    } finally {
      setCapabilityToken("");
    }
  };

  return (
    <div className="qualification-station">
      <div className="qualification-title">
        <UserCheck aria-hidden="true" weight="duotone" />
        <div>
          <h3>Human qualification gate</h3>
          <p>Separate from requirements approval and unreachable from the agent-facing MCP.</p>
        </div>
      </div>

      {qualified ? (
        <div className="approval-record">
          <CheckSquare aria-hidden="true" weight="fill" />
          <div>
            <strong>Exact human qualification is active</strong>
            <p>
              {exportEnabled
                ? "Prototype export is enabled for this revision only. Manufacturing release remains separate."
                : "The attestation remains visible, but prototype export is locked by independent workflow or engineering gates. Manufacturing release remains separate."}
            </p>
          </div>
        </div>
      ) : !ready ? (
        <div className="blocked-approval">
          <LockKey aria-hidden="true" weight="fill" />
          <div>
            <strong>Qualification unavailable</strong>
            <p>
              Completion and digests are not enough. The exact head revision must have a current, passing
              <code> evleda.human-physical-evidence.v2 </code> record, its bound raw and parsed artifacts, and
              the complete current evidence root. The daemon revalidates all seven physical categories and
              source bytes before accepting qualification.
            </p>
          </div>
        </div>
      ) : (
        <details
          className="qualification-disclosure"
          open={opened}
          onToggle={(event) => setOpened(event.currentTarget.open)}
        >
          <summary>Record exact hardware qualification</summary>
          {opened ? (
            <form
              className="qualification-form"
              onSubmit={(event) => void handleSubmit(event)}
              autoComplete="off"
              noValidate
            >
            <div className="qualification-binding" aria-label="Qualification binding identities">
              <div><span>Design manifest</span><code title={revisionDigest}>{shortDigest(revisionDigest)}</code></div>
              <div><span>Requirements</span><code title={requirementsDigest}>{shortDigest(requirementsDigest)}</code></div>
              <div><span>Evidence root</span><code title={evidenceRootDigest}>{shortDigest(evidenceRootDigest)}</code></div>
            </div>

            {Object.keys(errors).length > 0 ? (
              <div className="error-summary" role="alert" tabIndex={-1} ref={errorRef}>
                <strong>Complete the qualification record</strong>
                <ul>
                  {errors.scope ? <li><a href="#qualification-scope">{errors.scope}</a></li> : null}
                  {errors.rationale ? <li><a href="#qualification-rationale">{errors.rationale}</a></li> : null}
                  {errors.capabilityToken ? <li><a href="#hardware-qualification-credential">{errors.capabilityToken}</a></li> : null}
                  {errors.acknowledgement ? <li><a href="#qualification-acknowledgement">{errors.acknowledgement}</a></li> : null}
                </ul>
              </div>
            ) : null}

            <p className="field-help">
              A metadata precheck found passing physical-v2 evidence for this exact head. The daemon remains
              authoritative: it verifies the full evidence root, all seven categories, linked content bytes,
              time windows, and credential-bound hardware qualifier before recording anything.
            </p>

            <div className="field-group">
              <label htmlFor="qualification-scope">Controlled prototype scope</label>
              <input
                id="qualification-scope"
                maxLength={500}
                required
                value={scope}
                aria-invalid={errors.scope ? "true" : "false"}
                aria-describedby={errors.scope ? "qualification-scope-error" : undefined}
                onChange={(event) => setScope(event.target.value)}
              />
              {errors.scope ? <span id="qualification-scope-error" className="field-error">{errors.scope}</span> : null}
            </div>

            <div className="field-group">
              <label htmlFor="qualification-rationale">Evidence and physical review rationale</label>
              <textarea
                id="qualification-rationale"
                rows={4}
                maxLength={4_000}
                required
                value={rationale}
                aria-invalid={errors.rationale ? "true" : "false"}
                aria-describedby={errors.rationale ? "qualification-rationale-error" : undefined}
                onChange={(event) => setRationale(event.target.value)}
              />
              {errors.rationale ? <span id="qualification-rationale-error" className="field-error">{errors.rationale}</span> : null}
            </div>

            <div className="field-group capability-field">
              <label htmlFor="hardware-qualification-credential">Hardware qualification credential</label>
              <input
                id="hardware-qualification-credential"
                name="evleda-hardware-qualification-credential"
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                value={capabilityToken}
                aria-invalid={errors.capabilityToken ? "true" : "false"}
                aria-describedby="hardware-qualification-credential-help hardware-qualification-credential-error"
                onChange={(event) => setCapabilityToken(event.target.value)}
              />
              <span id="hardware-qualification-credential-help" className="field-help">
                This value is valid only for the configured hardware qualifier. It is sent in the
                human credential header, retained only in this field for the current attempt, cleared after
                submission, and never persisted to project, local, or session storage.
              </span>
              {errors.capabilityToken ? <span id="hardware-qualification-credential-error" className="field-error">{errors.capabilityToken}</span> : null}
            </div>

            <label
              id="qualification-acknowledgement"
              className={`checkbox-row${errors.acknowledgement ? " checkbox-error" : ""}`}
            >
              <input
                type="checkbox"
                required
                checked={acknowledged}
                aria-invalid={errors.acknowledgement ? "true" : "false"}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                I am the human hardware qualifier. I reviewed the bound evidence and physical scope. This is
                not certification, production release, or general proof for other revisions.
              </span>
            </label>
            {errors.acknowledgement ? <span className="field-error">{errors.acknowledgement}</span> : null}

            <button className="button button-danger full-button" type="submit" disabled={busy}>
              <UserCheck aria-hidden="true" weight="fill" />
              {busy ? "Binding qualification…" : "Record exact qualification"}
            </button>
            </form>
          ) : null}
        </details>
      )}
    </div>
  );
}
