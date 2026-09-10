import type { FluxSequencedEventDto } from "./model";
import { DiagnosticNotice } from "./DiagnosticNotice";
import { safeDisplay, safeDisplayLabel } from "./safe-display";

export function OperationTimeline({ events }: { readonly events: readonly FluxSequencedEventDto[] }) {
  return <section className="flux-timeline" aria-labelledby="flux-timeline-title"><div className="flux-panel-heading"><p className="overline">04 / OPERATION LOG</p><h2 id="flux-timeline-title">Operation timeline</h2></div><ol>{events.length === 0 ? <li className="flux-empty">No operations recorded for this run.</li> : events.map((event) => <li key={event.eventSeq}><span className="flux-state">{safeDisplayLabel(event.kind)}</span><div><strong>{safeDisplayLabel(event.kind)}</strong><p>{event.diagnostic == null ? safeDisplay(event.detail) : "Structured terminal diagnostic recorded."}</p><DiagnosticNotice diagnostic={event.diagnostic} legacy={(event.kind === "run_failed" || event.kind === "run_blocked") && event.diagnostic == null} compact /></div><time dateTime={safeDisplay(event.at)}>#{safeDisplay(event.eventSeq)}</time></li>)}</ol></section>;
}
