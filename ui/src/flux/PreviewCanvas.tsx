import type { FluxApi, FluxPreviewDto, FluxRunDto } from "./model";
import { safeDisplay, safeDisplayLabel } from "./safe-display";

export function PreviewCanvas({ client, run, preview, busy, onRefresh }: { readonly client: FluxApi; readonly run: FluxRunDto | undefined; readonly preview: FluxPreviewDto | undefined; readonly busy: boolean; readonly onRefresh: () => void }) {
  return <section className="flux-canvas" aria-labelledby="flux-preview-title">
    <header className="flux-panel-heading flux-canvas-heading"><div><p className="overline">02 / CANDIDATE VIEWS</p><h2 id="flux-preview-title">Native-source preview</h2></div><button className="button button-quiet" type="button" disabled={busy || run?.preview === undefined} onClick={onRefresh}>{busy ? "Refreshing…" : "Refresh views"}</button></header>
    <p className="flux-canvas-note">Read-only candidate geometry. These exact route-bound images are not proof that ERC or DRC is clean.</p>
    <div className="flux-preview-grid">{run && preview ? preview.artifacts.map((artifact) => <article className="flux-preview" key={artifact.kind}><header><h3>{safeDisplayLabel(artifact.kind)}</h3><span className="flux-check flux-check-review">preview</span></header><img src={client.previewUrl(run.id, artifact.kind)} alt={`${safeDisplayLabel(artifact.kind)} candidate preview`} /><footer><span>{safeDisplay(artifact.mediaType)}</span><time dateTime={safeDisplay(preview.refreshedAt)}>Preview only</time></footer></article>) : <p className="flux-empty">Prepare a run to render its candidate views.</p>}</div>
  </section>;
}
