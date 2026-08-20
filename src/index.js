import { getStatus, readSnapshot, recordFailure, resetBaseline, runWatch } from "./watcher.js";
import { buildErrorMessage, sendTelegram, setupTelegram } from "./telegram.js";
import { resilientSourceFetch } from "./resilient-fetch.js";
import { dashboard, dashboardScript } from "./dashboard.js";

const SECURITY_HEADERS={"x-content-type-options":"nosniff","referrer-policy":"no-referrer","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src https://models.dev; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'"};
function json(data,status=200){return new Response(JSON.stringify(data,null,2),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...SECURITY_HEADERS}});}
function authorized(request,env){if(!env.ADMIN_TOKEN)return false;const bearer=request.headers.get("authorization")?.replace(/^Bearer\s+/i,""),header=request.headers.get("x-admin-token");return bearer===env.ADMIN_TOKEN||header===env.ADMIN_TOKEN;}
function adminGuard(request,env){if(authorized(request,env))return null;return json({error:env.ADMIN_TOKEN?"unauthorized":"ADMIN_TOKEN is not configured"},env.ADMIN_TOKEN?401:503);}
async function manualCheck(request,env,forceNotify=false){const guard=adminGuard(request,env);if(guard)return guard;try{const result=await runWatch(env,{forceNotify,fetchImpl:resilientSourceFetch});return json({status:result.status,changes:result.changes,optimization:result.optimization});}catch(error){return json(await recordFailure(env,error),502);}}

export default{
 async fetch(request,env){const url=new URL(request.url);
  if(request.method==="GET"&&url.pathname==="/dashboard.js")return new Response(dashboardScript,{headers:{"content-type":"application/javascript; charset=utf-8","cache-control":"public, max-age=3600",...SECURITY_HEADERS}});
  if(request.method==="GET"&&url.pathname==="/"){const status=await getStatus(env);return new Response(dashboard(status),{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store",...SECURITY_HEADERS}});}
  if(request.method==="GET"&&url.pathname==="/health"){const status=await getStatus(env);return json({ok:status.ok,configured:status.configured,meta:status.meta,error:status.error},status.ok?200:503);}
  if(request.method==="GET"&&url.pathname==="/status"){const g=adminGuard(request,env);if(g)return g;return json(await getStatus(env));}
  if(request.method==="GET"&&url.pathname==="/snapshot"){const g=adminGuard(request,env);if(g)return g;const s=await readSnapshot(env);return s?json(s):json({error:"no baseline yet"},404);}
  if(request.method==="POST"&&url.pathname==="/check")return manualCheck(request,env,false);
  if(request.method==="POST"&&url.pathname==="/check/notify")return manualCheck(request,env,true);
  if(request.method==="POST"&&url.pathname==="/baseline/reset"){const g=adminGuard(request,env);if(g)return g;await resetBaseline(env);return json({ok:true,message:"Baseline cleared; next successful check will bootstrap a new baseline."});}
  if(request.method==="POST"&&url.pathname==="/telegram/setup"){const g=adminGuard(request,env);if(g)return g;try{const setup=await setupTelegram(env);const status=await getStatus(env);if(status.error){await sendTelegram(env,buildErrorMessage(new Error(status.error.message),status.error.lastSeenAt||new Date().toISOString(),env.TIMEZONE||"America/Chicago"));}return json({...setup,degraded:Boolean(status.error)});}catch(error){return json({ok:false,error:String(error?.message??error)},400);}}
  if(request.method==="POST"&&url.pathname==="/telegram/test"){const g=adminGuard(request,env);if(g)return g;try{await sendTelegram(env,"🧪 <b>OPENCODE GO WATCH · TEST</b>\n━━━━━━━━━━━━━━━━━━━━\nTelegram delivery is working.\n\n✅ HTML cards\n✅ Inline navigation\n✅ Worker → Telegram");return json({ok:true});}catch(error){return json({ok:false,error:String(error?.message??error)},502);}}
  return json({error:"not found"},404);
 },
 async scheduled(controller,env,ctx){ctx.waitUntil((async()=>{try{const result=await runWatch(env,{now:new Date(controller.scheduledTime),fetchImpl:resilientSourceFetch});console.log(JSON.stringify({event:"watch.complete",status:result.status,changes:result.changes.length,optimization:result.optimization}));}catch(error){console.error("watch failed",error);await recordFailure(env,error);}})());}
};
