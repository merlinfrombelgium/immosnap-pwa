import { resolveImmowebAgency } from "./portals/immoweb.js";
import { renderPage, closeBrowser } from "./lib/browser.js";
async function main(){
  for(const u of [
    "https://www.immoweb.be/nl/groep/immotijl/tijl",
    "https://www.immoweb.be/nl/agentschap/vastgoed-sinnaeve/2654615",
  ]){
    try{ const c = await resolveImmowebAgency(u); console.log(u, "->", c.length, "listings"); c.slice(0,12).forEach(x=>console.log("   ",x.url.replace("https://www.immoweb.be",""))); }
    catch(e){ console.log(u,"ERR",(e as Error).message); }
  }
  // spotto makelaar page raw
  console.log("\n=== SPOTTO Immo Lot makelaar ===");
  try{
    const {html,status} = await renderPage("https://www.spotto.be/nl/makelaar/immo-benny-simons/9_O1wiExPUiR6vdi5jxqIQ".replace("immo-benny-simons/9_O1wiExPUiR6vdi5jxqIQ","immo-lot/x"),{settle:2500,retries:1,timeout:30000});
    console.log("(placeholder) status",status,"len",html.length);
  }catch(e){console.log("spotto ERR",(e as Error).message);}
  await closeBrowser();
}
main().catch(e=>{console.error(e);process.exit(1);});
