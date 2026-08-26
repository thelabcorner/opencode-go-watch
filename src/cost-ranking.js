// Backwards-compatible facade. Existing rendering code imports the historical
// "cheapness" names while the implementation is now Usage Yield V2.
export {
  basePricingName,
  buildStandardWorkloadCorpus,
  buildGoUsageYieldRanking,
  buildGoUsageYieldRanking as buildGoCheapnessRanking,
  buildZenUsageYieldRanking,
  buildZenUsageYieldRanking as buildZenCheapnessRanking,
  peakFractionFromNotes,
  usageYieldFor,
  usageYieldFor as cheapnessFor,
} from "./usage-yield.js";
