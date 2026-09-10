import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { contentIdentity } from "../core/canonical.js";
import { KicadCliAdapter, type KicadCliAdapterOptions } from "../integrations/kicad-cli.js";

/** All roots, source selection and executable policy belong to the owning host. */
export function createToolboxPreview(input: {
  readonly pcbPath: string;
  readonly schematicPath: string;
  readonly adapterOptions: KicadCliAdapterOptions & { readonly outputRoot: string;
    readonly expectedExecutableIdentity: NonNullable<KicadCliAdapterOptions["expectedExecutableIdentity"]> };
  readonly createAdapter: typeof KicadCliAdapter.create;
}) {
  const pcbPath = path.resolve(input.pcbPath);
  const schematicPath = path.resolve(input.schematicPath);
  const options = { ...input.adapterOptions,
    expectedExecutableIdentity: { ...input.adapterOptions.expectedExecutableIdentity },
    ...(input.adapterOptions.environment === undefined ? {} : { environment: { ...input.adapterOptions.environment } }) };
  const createAdapter = input.createAdapter;
  // A new adapter snapshots the CURRENT saved candidate on each request.
  return async (view: "top" | "assembly") => {
    if (view !== "top" && view !== "assembly") throw new Error("Preview view must be top or assembly.");
    const adapter = await createAdapter(options);
    const result = await adapter.exportPcbSvg({ pcbPath, schematicPath, view,
      outputDirectory: path.join(options.outputRoot, `toolbox-preview-${randomUUID()}`),
      ...(options.signal === undefined ? {} : { signal: options.signal }) });
    // Native SVG uses physical millimetres. Keep its baseline density bounded;
    // Sharp rerenders vector input for the requested output dimensions.
    const raster = await sharp(Buffer.from(result.source, "utf8"), { density: 72, limitInputPixels: 40_000_000, failOn: "warning" })
      .resize({ width: 1800, height: 1400, fit: "inside" }).flatten({ background: "#ffffff" }).png().toBuffer({ resolveWithObject: true });
    if (raster.data.length > 4 * 1024 * 1024) throw new Error("Native PCB preview PNG exceeds the response bound.");
    const pngPath = path.join(path.dirname(result.pcbSvg.path), `board-${view}.png`);
    await writeFile(pngPath, raster.data, { flag: "wx" });
    return { ...result, mimeType: "image/svg+xml", resourceUri: `evleda://pcb-preview/${result.pcbSvg.sha256}/${view}`,
      png: { path: pngPath, identity: contentIdentity(raster.data), width: raster.info.width, height: raster.info.height,
        data: raster.data.toString("base64"), mimeType: "image/png" as const, sourceSvgSha256: result.pcbSvg.sha256 },
      assurance: "PNG rasterized from the exact native saved-source SVG; no generated artwork, live-board rendering, readability verdict, or design acceptance is implied." };
  };
}

export type ToolboxPreview = ReturnType<typeof createToolboxPreview>;
export type ToolboxPreviewResult = Awaited<ReturnType<ToolboxPreview>>;
