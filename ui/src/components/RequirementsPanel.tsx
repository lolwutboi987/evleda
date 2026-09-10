import { CheckSquare } from "@phosphor-icons/react/dist/csr/CheckSquare";
import { ListChecks } from "@phosphor-icons/react/dist/csr/ListChecks";
import { LockKey } from "@phosphor-icons/react/dist/csr/LockKey";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { useEffect, useRef, useState } from "react";
import type { ApprovalInput, RequirementsDocument } from "../model";
import { shortDigest } from "../model";
import { SectionHeading } from "./SectionHeading";
import { StatusTag } from "./StatusTag";

interface ApprovalErrors {
  readonly rationale?: string;
  readonly acknowledgement?: string;
  readonly capabilityToken?: string;
}

interface RequirementsPanelProps {
  readonly requirements?: RequirementsDocument | undefined;
  readonly busy: boolean;
  readonly requiresCapabilityToken: boolean;
  readonly onApprove: (input: ApprovalInput) => Promise<void>;
}

const validateApproval = (
  rationale: string,
  acknowledged: boolean,
  capabilityToken: string,
  requiresCapabilityToken: boolean
): ApprovalErrors => {
  const errors: {
    rationale?: string;
    acknowledgement?: string;
    capabilityToken?: string;
  } = {};
  if (rationale.trim().length < 20) errors.rationale = "Record at least 20 characters of review rationale.";
  if (!acknowledged) errors.acknowledgement = "Confirm the scope of this approval.";
  if (requiresCapabilityToken && capabilityToken.length === 0) {
    errors.capabilityToken = "Enter the role-scoped requirements review credential.";
  }
  return errors;
};

export function RequirementsPanel({
  requirements,
  busy,
  requiresCapabilityToken,
  onApprove
}: RequirementsPanelProps) {
  const [rationale, setRationale] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [capabilityToken, setCapabilityToken] = useState("");
  const [errors, setErrors] = useState<ApprovalErrors>({});
  const errorsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (Object.keys(errors).length > 0) errorsRef.current?.focus();
  }, [errors]);

  if (!requirements) {
    return (
      <section className="bench-panel requirements-panel" aria-labelledby="requirements-title">
        <SectionHeading id="requirements-title" index="C" title="Requirements gate" />
        <div className="empty-state">
          <ListChecks aria-hidden="true" weight="duotone" />
          <div>
            <strong>No requirements document</strong>
            <p>The run has not emitted a reviewable requirements revision.</p>
          </div>
        </div>
      </section>
    );
  }

  const blocking = requirements.unresolvedAssumptions.filter(
    (assumption) => assumption.severity === "blocking"
  );
  const approved = Boolean(requirements.approvalId);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateApproval(
      rationale,
      acknowledged,
      capabilityToken,
      requiresCapabilityToken
    );
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || blocking.length > 0) return;
    try {
      await onApprove({
        rationale: rationale.trim(),
        subjectDigest: requirements.identity.digest,
        ...(requiresCapabilityToken ? { capabilityToken } : {})
      });
    } finally {
      setCapabilityToken("");
    }
  };

  return (
    <section className="bench-panel requirements-panel" aria-labelledby="requirements-title">
      <SectionHeading
        id="requirements-title"
        index="C"
        title="Requirements gate"
        aside={
          approved ? (
            <StatusTag status="pass" label="Approval bound" />
          ) : blocking.length > 0 ? (
            <StatusTag status="blocked" label={`${blocking.length} blocking`} />
          ) : (
            <StatusTag status="waiting_approval" />
          )
        }
      />
      <div className="requirements-identity">
        <div>
          <span>Schema</span>
          <strong>{requirements.schemaVersion}</strong>
        </div>
        <div>
          <span>Document identity</span>
          <strong className="mono" title={requirements.identity.digest}>
            {shortDigest(requirements.identity.digest)}
          </strong>
        </div>
        <div>
          <span>Requirements</span>
          <strong>{requirements.requirements.length}</strong>
        </div>
      </div>

      <div className="table-scroll" tabIndex={0} role="region" aria-label="Parsed requirements table">
        <table className="data-table requirements-table">
          <caption>Parsed requirements bound to the current requirements digest</caption>
          <thead>
            <tr>
              <th scope="col">Requirement</th>
              <th scope="col">Priority</th>
              <th scope="col">Hazard</th>
              <th scope="col">Verification / acceptance</th>
            </tr>
          </thead>
          <tbody>
            {requirements.requirements.map((entry) => (
              <tr key={entry.id}>
                <th scope="row">
                  <span className="table-kicker">{entry.category}</span>
                  {entry.statement}
                  <code title={entry.id}>{shortDigest(entry.id)}</code>
                </th>
                <td>{entry.priority}</td>
                <td>{entry.hazardClass}</td>
                <td>
                  <strong>{entry.verificationMethod}</strong>
                  <span>{entry.acceptanceCriteria}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="requirements-lower-grid">
        <section className="subpanel" aria-labelledby="assumptions-title">
          <h3 id="assumptions-title">Unresolved assumptions</h3>
          {requirements.unresolvedAssumptions.length > 0 ? (
            <ul className="issue-list">
              {requirements.unresolvedAssumptions.map((assumption) => (
                <li key={assumption.id} className={`issue-${assumption.severity}`}>
                  <Warning aria-hidden="true" weight="fill" />
                  <div>
                    <strong>{assumption.severity}</strong>
                    <p>{assumption.statement}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="inline-clear-state">
              <CheckSquare aria-hidden="true" weight="fill" />
              <span>No unresolved assumptions were reported by the parser.</span>
            </div>
          )}
          <details className="exclusions-disclosure">
            <summary>Declared exclusions ({requirements.exclusions.length})</summary>
            <ul>
              {requirements.exclusions.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </details>
        </section>

        <section className="subpanel approval-subpanel" aria-labelledby="approval-title">
          <h3 id="approval-title">Human requirements approval</h3>
          {approved ? (
            <div className="approval-record">
              <CheckSquare aria-hidden="true" weight="fill" />
              <div>
                <strong>Approval is bound to this exact document</strong>
                <p>
                  Record <code>{requirements.approvalId}</code> permits workflow continuation only. It is
                  not hardware qualification or manufacturing release.
                </p>
              </div>
            </div>
          ) : blocking.length > 0 ? (
            <div className="blocked-approval">
              <LockKey aria-hidden="true" weight="fill" />
              <div>
                <strong>Approval is fail-closed</strong>
                <p>Resolve all {blocking.length} blocking assumptions before a reviewer can approve.</p>
              </div>
            </div>
          ) : (
            <form
              className="approval-form"
              onSubmit={(event) => void handleSubmit(event)}
              autoComplete="off"
              noValidate
            >
              {Object.keys(errors).length > 0 ? (
                <div className="error-summary" role="alert" tabIndex={-1} ref={errorsRef}>
                  <strong>Complete the approval record</strong>
                  <ul>
                    {errors.rationale ? <li><a href="#approval-rationale">{errors.rationale}</a></li> : null}
                    {errors.acknowledgement ? <li><a href="#approval-acknowledgement">{errors.acknowledgement}</a></li> : null}
                    {errors.capabilityToken ? <li><a href="#requirements-review-credential">{errors.capabilityToken}</a></li> : null}
                  </ul>
                </div>
              ) : null}
              <p className="field-help">
                The daemon records the reviewer identity bound to this credential; this form cannot
                choose or override that actor.
              </p>
              <div className="field-group">
                <label htmlFor="approval-rationale">Review rationale</label>
                <textarea
                  id="approval-rationale"
                  rows={3}
                  maxLength={4_000}
                  required
                  value={rationale}
                  aria-invalid={errors.rationale ? "true" : "false"}
                  aria-describedby={errors.rationale ? "approval-rationale-error" : undefined}
                  onChange={(event) => setRationale(event.target.value)}
                  placeholder="Limits checked against the source brief; exclusions and acceptance criteria reviewed…"
                />
                {errors.rationale ? <span id="approval-rationale-error" className="field-error">{errors.rationale}</span> : null}
              </div>
              <label
                id="approval-acknowledgement"
                className={`checkbox-row${errors.acknowledgement ? " checkbox-error" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={acknowledged}
                  required
                  aria-invalid={errors.acknowledgement ? "true" : "false"}
                  aria-describedby={errors.acknowledgement ? "approval-acknowledgement-error" : undefined}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>
                  I am a human requirements reviewer. This approval covers only this digest and does not
                  qualify hardware or authorize manufacturing.
                </span>
              </label>
              {errors.acknowledgement ? (
                <span id="approval-acknowledgement-error" className="field-error">
                  {errors.acknowledgement}
                </span>
              ) : null}
              {requiresCapabilityToken ? (
                <div className="field-group capability-field">
                  <label htmlFor="requirements-review-credential">Requirements review credential</label>
                  <input
                    id="requirements-review-credential"
                    name="evleda-requirements-review-credential"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    value={capabilityToken}
                    aria-invalid={errors.capabilityToken ? "true" : "false"}
                    aria-describedby="requirements-review-credential-help requirements-review-credential-error"
                    onChange={(event) => setCapabilityToken(event.target.value)}
                  />
                  <span id="requirements-review-credential-help" className="field-help">
                    This value is valid only for the configured requirements reviewer. It is sent in
                    the human credential header, retained only in this field for the current attempt, cleared
                    after submission, and never persisted to project, local, or session storage.
                  </span>
                  {errors.capabilityToken ? (
                    <span id="requirements-review-credential-error" className="field-error">
                      {errors.capabilityToken}
                    </span>
                  ) : null}
                </div>
              ) : (
                <p className="demo-token-note">Demo mode does not request or retain a human credential.</p>
              )}
              <button className="button button-primary full-button" type="submit" disabled={busy}>
                <CheckSquare aria-hidden="true" weight="fill" />
                {busy ? "Binding approval…" : "Approve this requirements digest"}
              </button>
            </form>
          )}
        </section>
      </div>
    </section>
  );
}
