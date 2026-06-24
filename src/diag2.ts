import { renderPage, closeBrowser } from "./lib/browser.js";
async function diag(url:string){
  try{
    const {html,status,finalUrl} = await renderPage(url,{settle:4500,retries:2,timeout:55000,scroll:8});
    const links=Array.from(new Set((html.match(/href="([^"]*te-koop[^"]*?\/\d{5,}[^"]*)"/g)||[]).map(s=>s.replace(/href="|"/g,"")))).slice(0,15);
    const imgs=(html.match(/https?:\/\/[^"'\s]+?\.(?:jpg|jpeg|webp)/gi)||[]).length;
    console.log(`\n== ${url}\n  status ${status} final ${finalUrl} len ${html.length} imgs~${imgs} listinglinks ${links.length}`);
    links.forEach(l=>console.log("   ",l));
    if(links.length===0){ // show any anchor with digits
      const any=Array.from(new Set((html.match(/href="([^"]*\/\d{5,}[^"]*)"/g)||[]).map(s=>s.replace(/href="|"/g,"")))).slice(0,10);
      any.forEach(l=>console.log("   ?",l));
    }
  }catch(e){console.log(url,"ERR",(e as Error).message);}
}
async function main(){
  await diag("https://www.immotijl.be/te-koop");
  await diag("https://immolot.be/te-koop/");
  await diag("https://vastgoedsinnaeve.be/te-koop");
  await closeBrowser();
}
main().catch(e=>{console.error(e);process.exit(1);});
