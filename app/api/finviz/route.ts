import { stockScreenerRows } from "@/lib/stock-universe";
import { NextRequest, NextResponse } from "next/server";
import { parse } from "csv-parse/sync";
import { recordPriceSnapshots } from "@/lib/mirror";
import { loadFeedConfig } from "@/lib/feed-config";
import { finvizFilters, matchesStockConfig, validConfigValue, type FeedConfig } from "@/lib/feed-preferences";
import { fetchFinviz, finvizRetryAt, FinvizRateLimitError } from "@/lib/finviz-backoff";
export const dynamic = "force-dynamic";
type RecordRow = Record<string,string>;
type Payload = {results:RecordRow[];count:number;fetchedAt:string};
const caches = new Map<string,{payload?:Payload;expires:number;pending?:Promise<Payload>}>();
const CACHE_MS = 60 * 1000;
async function fetchStocks(token:string,config:FeedConfig):Promise<Payload> {
  const params=new URLSearchParams({v:"152",c:"1,2,3,4,5,6,7,64,65,66,67",f:finvizFilters(config),o:"ticker",auth:token});
  const response=await fetchFinviz(`https://elite.finviz.com/export/screener?${params}`,{cache:"no-store",redirect:"follow",signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw new Error(`Finviz returned HTTP ${response.status}.`);
  const rows=parse(await response.text(),{columns:true,skip_empty_lines:true,trim:true}) as RecordRow[];
  const results=stockScreenerRows(rows).filter(row=>matchesStockConfig({marketCap:row["Market Cap"]??"",volume:row.Volume??"",relativeVolume:row["Relative Volume"]?.trim()?Number(row["Relative Volume"]):null,change:Number((row.Change??"").replace(/[%,$]/g,""))},config));
  const payload={results,count:results.length,fetchedAt:new Date().toISOString()};
  await recordPriceSnapshots(results,payload.fetchedAt);
  return payload;
}
export async function GET(request:NextRequest){
  const token=process.env.FINVIZ_API_TOKEN;
  if(!token)return NextResponse.json({error:"FINVIZ_API_TOKEN is not configured."},{status:500});
  try{
    let config=await loadFeedConfig();
    if(request.nextUrl.searchParams.get("scope")==="mirror"){
      for(const key of ["marketCap","relativeVolume","currentVolume","priceChange"] as const){
        const value=request.nextUrl.searchParams.get(key);
        if(!validConfigValue(key,value))return NextResponse.json({error:"Invalid Mirror filter."},{status:400});
        config={...config,[key]:value!};
      }
    }
    const key=JSON.stringify([config.marketCap,config.relativeVolume,config.currentVolume,config.priceChange]);
    let entry=caches.get(key);
    if(!entry){if(caches.size>100)caches.clear();entry={expires:0};caches.set(key,entry);}
    if(entry.payload&&Date.now()<entry.expires)return NextResponse.json({...entry.payload,cached:true,stale:false});
    const rateLimited = () => {
      const retryAt = finvizRetryAt();
      const retry = retryAt ? new Date(retryAt).toISOString() : undefined;
      return entry.payload
        ? NextResponse.json({...entry.payload,cached:true,stale:true,warning:"Price provider is cooling down after a rate limit.",retryAt:retry})
        : NextResponse.json({error:"Price provider is rate-limiting requests.",retryAt:retry},{status:503});
    };
    if(finvizRetryAt())return rateLimited();
    try{
      if(!entry.pending)entry.pending=fetchStocks(token,config).finally(()=>{entry!.pending=undefined;});
      const payload=await entry.pending;entry.payload=payload;entry.expires=Date.now()+CACHE_MS;
      return NextResponse.json({...payload,cached:false,stale:false});
    }catch(error){
      if(error instanceof FinvizRateLimitError)return rateLimited();
      if(entry.payload)return NextResponse.json({...entry.payload,cached:true,stale:true,warning:"Price provider unavailable. Showing the last matching results."});
      return NextResponse.json({error:"Unable to fetch stocks matching Config."},{status:502});
    }
  }catch{return NextResponse.json({error:"Unable to load the screener configuration."},{status:503});}
}
