# Native global-label geometry fixture

`native-global-label-metrics.json` records 584 isolated KiCad 10.0.3 SVG observations: all 67 admitted plain-text characters, representative and actual RP2350 net names, and 128-character extremes at 0/90/180/270 degrees. It pins the CLI, schematic engine, exact source/SVG files, and unchanged isolated configuration tree. This is model characterization, not a current-project render or authoring receipt.

The passive frame begins at the exact source anchor and immediately follows its own stroked-text group in the SVG. The extractor requires an exact unique text/anchor match. Frame bounds include half the native 0.1524 mm stroke; glyph bounds come from the existing closed SVG reader. Every frame matches the model within one 0.0001 mm SVG coordinate quantum, and every glyph box is contained.

The formulas were checked against primary KiCad 10.0.3 sources:

- [Stroke-font advances and rounding](https://gitlab.com/kicad/code/kicad/-/blob/10.0.3/common/font/stroke_font.cpp)
- [Numeric stock glyph metrics](https://gitlab.com/kicad/code/kicad/-/blob/10.0.3/common/newstroke_font.cpp)
- [Text boundary inflation](https://gitlab.com/kicad/code/kicad/-/blob/10.0.3/common/font/font.cpp)
- [Passive global-label frame and offset](https://gitlab.com/kicad/code/kicad/-/blob/10.0.3/eeschema/sch_label.cpp)

The separate 20-case native justification matrix confirms 0/90 use `left` and 180/270 use `right`. `top`/`bottom` alone center vertical text longitudinally. The supported planning model requires the stock font, 1.524 mm regular visible text, passive shape, 0.375 label expansion ratio and 6 mil plot stroke. Unsupported markup, Unicode or settings fail closed.

The corrected envelope includes the frame stroke behind its anchor. Only an exact owned, same-net, collinear incoming connection may touch that narrow cap. Tree routes turn one grid step before the label and preserve a straight lead into its port. Old synthetic retry slots were enlarged where the previous 0.66-width estimate had incorrectly admitted geometry; collision, ownership and work-budget assertions remain intact.

Full scripts, failed preliminary observations and isolated reruns are retained outside the repository at `destination-verification/global-label-orientation-envelope-01`. The initial direct CLI characterization used ambient configuration and changed its working-directory preference; that incident was reported separately. The checked-in fixture comes from the subsequent isolated configuration run.
