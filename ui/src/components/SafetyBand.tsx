import { Circuitry } from "@phosphor-icons/react/dist/csr/Circuitry";
import { PlugsConnected } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { SealWarning } from "@phosphor-icons/react/dist/csr/SealWarning";
import { ShieldWarning } from "@phosphor-icons/react/dist/csr/ShieldWarning";
import type { LifecycleState } from "../model";
import { shortDigest } from "../model";

export type DataMode = "connecting" | "api" | "demo" | "error";

interface SafetyBandProps {
  readonly mode: DataMode;
  readonly lifecycle: LifecycleState;
  readonly projectName?: string | undefined;
  readonly runId?: string | undefined;
}

const connectionCopy: Record<DataMode, string> = {
  connecting: "Checking local daemon",
  api: "Local daemon connected",
  demo: "Local demo — API unavailable",
  error: "API error — no demo substitution"
};

export function SafetyBand({ mode, lifecycle, projectName, runId }: SafetyBandProps) {
  return (
    <>
      <header className="brand-header">
        <div className="brand-row">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <Circuitry weight="duotone" />
          </span>
          <div>
            <p className="eyebrow">EVLEDA / LOCAL WORKCELL</p>
            <h1>Commissioning Bench</h1>
          </div>
        </div>
        <div className={`connection-readout connection-${mode}`} role="status" aria-live="polite">
          <PlugsConnected aria-hidden="true" weight="bold" />
          <span>{connectionCopy[mode]}</span>
        </div>
        <dl className="header-identities">
          <div>
            <dt>Workpiece</dt>
            <dd title={projectName}>{projectName ?? "No project loaded"}</dd>
          </div>
          <div>
            <dt>Run</dt>
            <dd className="mono" title={runId}>{shortDigest(runId)}</dd>
          </div>
        </dl>
        </div>
      </header>
      <div className="safety-strip" aria-label="Release status" role="note">
        <span className="safety-flag safety-candidate">
          <SealWarning aria-hidden="true" weight="fill" />
          CANDIDATE
        </span>
        <span className="safety-flag safety-unqualified">
          <ShieldWarning aria-hidden="true" weight="fill" />
          {lifecycle === "candidate" ? "NOT HUMAN-QUALIFIED" : "HUMAN QUALIFICATION RECORDED"}
        </span>
        <span className="safety-flag safety-no-manufacture">
          <ShieldWarning aria-hidden="true" weight="fill" />
          {lifecycle === "release_authorized"
            ? "RELEASE AUTHORITY RECORDED — VERIFY SCOPE"
            : "NOT FOR MANUFACTURING"}
        </span>
        <p>
          Generated files are engineering candidates. Clean checks do not establish electrical safety,
          qualification, certification, or release.
        </p>
      </div>
    </>
  );
}
