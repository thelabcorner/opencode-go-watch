/**
 * JSDoc-only domain types for editor support. No runtime dependencies.
 *
 * @typedef {{requests5h:number|null, requestsWeek:number|null, requestsMonth:number|null, unlimited:boolean}} RequestEstimate
 * @typedef {{inputPerM:number|null, outputPerM:number|null, cachedReadPerM:number|null, cachedWritePerM:number|null, usageUsd:number|null}} PricingRow
 * @typedef {{inputTokens:number, cachedTokens:number, outputTokens:number}} RequestProfile
 * @typedef {{requests5h:number|null, bonus:string|null, unlimited:boolean}} ChartRow
 * @typedef {{fiveHourUsd:number, weeklyUsd:number, monthlyUsd:number}} UsageWindowReference
 * @typedef {{limits:UsageWindowReference, requests:Record<string, RequestEstimate>, pricing:Record<string, PricingRow>, profiles:Record<string, RequestProfile>, notes:Record<string,string>, usageText:string, monitorStructure:string}} DocsSnapshot
 * @typedef {{promoBanner:string|null, chart:Record<string, ChartRow>, monitorStructure:string}} GoSnapshot
 * @typedef {{schema:5, checkedAt:string, sources:{go:string,docs:string,api?:string}, go:GoSnapshot, docs:DocsSnapshot}} Snapshot
 */
export {};
