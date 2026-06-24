import { renderPage, closeBrowser } from "./lib/browser.js";
async function diag(url:string){
  try{
    const {html,status,finalUrl} = await renderPage(url,{settle:4000,retries:2,timeout:50000,scroll:8});
    const count=(re:RegExp)=>(html.match(re)||[]).length;
    console.log(`\n== ${url}`);
    console.log("  status",status,"finalUrl",finalUrl,"len",html.length);
    console.log("  /zoekertje/ :", count(/\/zoekertje\//g));
    console.log("  /classified/:", count(/\/classified\//g));
    console.log("  data-classified-id:", count(/classified-id|classifiedId|data-id=/g));
    console.log("  'geen resultaten'/'no results':", /geen resultaten|geen panden|no results/i.test(html));
    console.log("  has __NEXT_DATA__:", /__NEXT_DATA__/.test(html), " __INITIAL:", /__INITIAL_STATE__|window\.__/.test(html));
    const m=html.match(/href="(\/[a-z]{2}\/(?:zoekertje|classified)[^"]+)"/);
    console.log("  sample listing href:", m?.[1]||"(none)");
    // any href containing a 6+ digit id
    const ids=Array.from(new Set((html.match(/\/(\d{6,})(?:["/?])/g)||[]).slice(0,5)));
    console.log("  sample numeric ids:", ids.join(" "));
  }catch(e){console.log(url,"ERR",(e as Error).message);}
}
async function main(){
  await diag("https://www.immoweb.be/nl/groep/immotijl/tijl");
  await diag("https://www.immoweb.be/nl/agentschap/vastgoed-sinnaeve/834769");
  await closeBrowser();
}
main().catch(e=>{console.error(e);process.exit(1);});
