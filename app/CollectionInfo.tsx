export default function CollectionInfo({windowMinutes,status}:{windowMinutes:string;status:string}) {
 return <details style={{color:"#c9afc0",fontSize:12,margin:"10px 0"}}>
  <summary style={{cursor:"pointer",display:"inline-flex",gap:6,alignItems:"center"}}><span aria-hidden="true">ⓘ</span> Collection details</summary>
  <div style={{padding:"10px 12px",border:"1px solid #713259",borderRadius:8,marginTop:6,lineHeight:1.6}}>
   <p style={{margin:0}}>Messages count saved posts in the last {windowMinutes} minutes. Messages/min = count ÷ {windowMinutes}. Zero means no saved posts in that window; collection may not cover every ticker.</p>
   <p style={{margin:"6px 0 0"}}>{status}</p>
   <p style={{margin:"6px 0 0"}}>Finviz screener snapshots may be cached for up to 1 minute. Auto refresh checks for data; it does not guarantee a new market quote. TradingView displays its own feed and may be delayed.</p>
  </div>
 </details>;
}
