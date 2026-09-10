import { contentIdentity } from "../core/canonical.js";
import type { ContentIdentity } from "../domain/types.js";

/** Exact LF bytes of the captured KiCad 10.0 blank-board serialization. */
export const NATIVE_EMPTY_BOARD_LF_IDENTITY: Readonly<ContentIdentity> = Object.freeze({
  algorithm: "sha256",
  digest: "8be439fee8716117c4da47e1e947c749ff4889df564d25a51f2640dec48f4a09",
  size: 1733,
});

/** Derived Windows line endings; this identity is not a separate native Save capture. */
export const NATIVE_EMPTY_BOARD_CRLF_IDENTITY: Readonly<ContentIdentity> = Object.freeze({
  algorithm: "sha256",
  digest: "5f482a9458a6c5710ec5df740495991198d31009be38bce9c823abf0e83b4a85",
  size: 1814,
});

// Embedded so a new project does not depend on a runtime asset or evidence path.
// Independent captured bytes are retained in the test fixture for verification.
const nativeEmptyBoardLf = `(kicad_pcb
	(version 20260206)
	(generator "pcbnew")
	(generator_version "10.0")
	(general
		(thickness 1.6)
		(legacy_teardrops no)
	)
	(paper "A4")
	(layers
		(0 "F.Cu" signal)
		(2 "B.Cu" signal)
		(13 "F.Paste" user)
		(15 "B.Paste" user)
		(5 "F.SilkS" user "F.Silkscreen")
		(7 "B.SilkS" user "B.Silkscreen")
		(1 "F.Mask" user)
		(3 "B.Mask" user)
		(25 "Edge.Cuts" user)
		(27 "Margin" user)
		(31 "F.CrtYd" user "F.Courtyard")
		(29 "B.CrtYd" user "B.Courtyard")
		(35 "F.Fab" user)
		(33 "B.Fab" user)
	)
	(setup
		(pad_to_mask_clearance 0)
		(allow_soldermask_bridges_in_footprints no)
		(tenting
			(front yes)
			(back yes)
		)
		(covering
			(front no)
			(back no)
		)
		(plugging
			(front no)
			(back no)
		)
		(capping no)
		(filling no)
		(pcbplotparams
			(layerselection 0x00000000_00000000_55555555_5755f5ff)
			(plot_on_all_layers_selection 0x00000000_00000000_00000000_00000000)
			(disableapertmacros no)
			(usegerberextensions no)
			(usegerberattributes yes)
			(usegerberadvancedattributes yes)
			(creategerberjobfile yes)
			(dashed_line_dash_ratio 12)
			(dashed_line_gap_ratio 3)
			(svgprecision 4)
			(plotframeref no)
			(mode 1)
			(useauxorigin no)
			(pdf_front_fp_property_popups yes)
			(pdf_back_fp_property_popups yes)
			(pdf_metadata yes)
			(pdf_single_document no)
			(dxfpolygonmode yes)
			(dxfimperialunits yes)
			(dxfusepcbnewfont yes)
			(psnegative no)
			(psa4output no)
			(plot_black_and_white yes)
			(sketchpadsonfab no)
			(plotpadnumbers no)
			(hidednponfab no)
			(sketchdnponfab yes)
			(crossoutdnponfab yes)
			(subtractmaskfromsilk no)
			(outputformat 1)
			(mirror no)
			(drillshape 1)
			(scaleselection 1)
			(outputdirectory "")
		)
	)
	(embedded_fonts no)
)
`;

const actualLfIdentity = contentIdentity(nativeEmptyBoardLf);
if (actualLfIdentity.digest !== NATIVE_EMPTY_BOARD_LF_IDENTITY.digest
    || actualLfIdentity.size !== NATIVE_EMPTY_BOARD_LF_IDENTITY.size) {
  throw new Error("Pinned native empty-board LF seed identity changed.");
}

/** New-project bytes only. Existing projects retain their recorded board bytes. */
export function createNativeEmptyBoardSeed(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? nativeEmptyBoardLf.replaceAll("\n", "\r\n") : nativeEmptyBoardLf;
}
