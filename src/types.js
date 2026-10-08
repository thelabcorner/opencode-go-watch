/**
 * JSDoc-only domain types for editor support. No runtime dependencies.
 *
 * @typedef {"finite"|"unlimited"|"unknown"} LimitState
 * @typedef {{requests5h:number|null, requestsWeek:number|null, requestsMonth:number|null, promotionMultiplier:number|null, promotionTiming:string|null, limitState:LimitState, limitEvidence:string, unlimited:boolean}} RequestEstimate
 * @typedef {{inputPerM:number|null, outputPerM:number|null, cachedReadPerM:number|null, cachedWritePerM:number|null, usageUsd:number|null}} PricingRow
 * @typedef {{inputTokens:number, cachedTokens:number, outputTokens:number}} RequestProfile
 * @typedef {{requests5h:number|null, baseRequests5h?:number|null, monthlyAllowanceUsd?:number|null, baseMonthlyAllowanceUsd?:number|null, plusRequests5h?:number|null, plusMonthlyAllowanceUsd?:number|null, plusLimitState?:LimitState, plusLimitEvidence?:string, bonus:string|null, regionUrl?:string|null, limitState:LimitState, limitEvidence:string, unlimited:boolean}} ChartRow
 * @typedef {{fiveHourUsd:number, weeklyUsd:number, monthlyUsd:number}} UsageWindowReference
 * @typedef {{limits:UsageWindowReference, requests:Record<string, RequestEstimate>, requestsPlus?:Record<string, RequestEstimate>, pricing:Record<string, PricingRow>, pricingPlus?:Record<string, PricingRow>, profiles:Record<string, RequestProfile>, notes:Record<string,string>, usageText:string, monitorStructure:string}} DocsSnapshot
 * @typedef {{promoBanner:string|null, chart:Record<string, ChartRow>, monitorStructure:string}} GoSnapshot
 * @typedef {{schema:8, checkedAt:string, sources:{go:string,docs:string,api?:string}, go:GoSnapshot, docs:DocsSnapshot}} Snapshot
 */
export {};
