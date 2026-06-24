import { renderPage, closeBrowser } from "./lib/browser.js";
async function main(){
  const d = await renderPage("https://www.spotto.be/nl/p/te-koop/9200-dendermonde/huis-schuurkouter-31-met-3-kamers-tuin-terras/2eSh3EDUGEmJ4gjeWsbYcg",{settle:4000,retries:3,timeout:50000,scroll:6});
  const html=d.html;
  // all distinct image-ish hosts
  const all=Array.from(new Set((html.match(/https?:\/\/[^"'\s)]+?\.(?:jpg|jpeg|webp|png)/gi)||[])));
  const hosts:Record<string,number>={};
  for(const u of all){ const h=new URL(u).host; hosts[h]=(hosts[h]||0)+1; }
  console.log("image hosts:",JSON.stringify(hosts));
  console.log("\nsample non-spotto-brand imgs:");
  all.filter(u=>!/assets\/img\/brand/.test(u)).slice(0,15).forEach(u=>console.log("  "+u));
  // data-src / srcset / background
  const ds=Array.from(new Set((html.match(/(?:data-src|data-bg|data-flickity-bg-lazyload)=["']([^"']+)["']/gi)||[]))).slice(0,8);
  console.log("\ndata-src:",ds.length); ds.forEach(x=>console.log("  "+x));
  const ss=Array.from(new Set((html.match(/srcset=["']([^"']+)["']/gi)||[]))).slice(0,4);
  console.log("srcset:",ss.length); ss.forEach(x=>console.log("  "+x.slice(0,200)));
  // look for a JSON blob with media / images array
  const ld=Array.from(html.matchAll(/<script[^>]*type=["']application\/(?:ld\+json|json)["'][^>]*>([\s\S]*?)<\/script>/gi)).map(m=>m[1]);
  console.log("\njson scripts:",ld.length);
  ld.forEach((j,i)=>{ if(/image|photo|street/i.test(j)) console.log(`  [${i}] ${j.slice(0,300).replace(/\s+/g," ")}`); });
  await closeBrowser();
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
