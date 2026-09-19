/** Independent test encoder; native production encoding is Python DOC13. */
import { canonicalJson } from "../../src/core/canonical.js";
export function compactPlaneStageFixture(value: Record<string, any>): Record<string, any> & { schemaVersion: string; sourcePool: string[]; rpcPadPool: Record<string, any>[] } {
  const result = structuredClone(value), sources: string[] = [], pads: Record<string, any>[] = [];
  const source = (owner: Record<string, any>, key: string) => {
    if (owner[key] === undefined) return;
    let index = sources.indexOf(owner[key]);
    if (index < 0) { index = sources.length; sources.push(owner[key]); }
    owner[key] = { sourceIndex: index };
  };
  for (const key of ["savedSourceBefore", "nativeSourceBefore", "nativeSourceUnfilled", "nativeSourceStaged", "savedSourceStaged", "currentSavedSource", "currentNativeSource"]) source(result, key);
  if (result.padSnapshot) for (const key of ["boardSourceBefore", "boardSourceAfter"]) source(result.padSnapshot, key);
  for (const call of result.rpc) {
    if (call.requestType === "kiapi.common.commands.SaveDocumentToString" && call.response) source(call.response, "contents");
    if (call.responseType === "kiapi.common.commands.GetItemsResponse" && call.response?.items) {
      call.response.items = call.response.items.map((item: Record<string, any>) => {
        if (item["@type"] !== "type.googleapis.com/kiapi.board.types.Pad") return item;
        let index = pads.findIndex(pad => canonicalJson(pad) === canonicalJson(item));
        if (index < 0) { index = pads.length; pads.push(item); }
        return { padIndex: index };
      });
    }
  }
  return { ...result, schemaVersion: "evleda.native-plane-stage.v2", sourcePool: sources, rpcPadPool: pads };
}
