/** Resource ceilings, not electrical design allowances. 1,536 straight tracks
 * yield at most 3,072 endpoints, below the existing 5M pairwise-analysis bound. */
export const FRESH_PCB_RESOURCE_LIMITS = Object.freeze({
  maximumLiveSourceBytes: 1024 * 1024,
  maximumSegments: 1536,
  maximumVias: 256,
  routePageSize: 32,
});
