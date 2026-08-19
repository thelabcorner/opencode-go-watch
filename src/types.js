/**
 * JSDoc-only domain types for editor support. No runtime dependencies.
 *
 * @typedef {{requests5h:number, requestsWeek:number, requestsMonth:number}} RequestEstimate
 * @typedef {{inputPerM:number|null, outputPerM:number|null, cachedReadPerM:number|null, cachedWritePerM:number|null, usageUsd:number|null}} PricingRow
 * @typedef {{inputTokens:number, cachedTokens:number, outputTokens:number}} RequestProfile
 * @typedef {{requests5h:number, bonus:string|null}} ChartRow
 * @typedef {{fiveHourUsd:number, weeklyUsd:number, monthlyUsd:number}} GlobalLimits
 * @typedef {{limits:GlobalLimits, requests:Record<string, RequestEstimate>, pricing:Record<string, PricingRow>, profiles:Record<string, RequestProfile>, notes:Record<string,string>, usageText:string}} DocsSnapshot
 * @typedef {{promoBanner:string|null, chart:Record<string, ChartRow>}} GoSnapshot
 * @typedef {{schema:1, checkedAt:string, sources:{go:string,docs:string}, go:GoSnapshot, docs:DocsSnapshot}} Snapshot
 */
export {};
