import { renderPage, closeBrowser, getBrowser, sleep } from "./lib/browser.js";

async function main(){
  const url = process.argv[2] || "https://www.immoweb.be/nl/agentschap/immotijl-aalst/3608721";
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  await page.setViewport({width:1366,height:2000});
  const resp = await page.goto(url, {waitUntil:"domcontentloaded", timeout:45000});
  console.log("status", resp?.status());
  await sleep(3500);
  // scroll to trigger lazy load
  await page.evaluate(async()=>{ for(let i=0;i<6;i++){ window.scrollBy(0, 1500); await new Promise(r=>setTimeout(r,400)); }});
  await sleep(2500);
  const data = await page.evaluate(()=>{
    const links = Array.from(document.querySelectorAll('a[href]')).map(a=>(a as HTMLAnchorElement).href);
    const listingLinks = Array.from(new Set(links.filter(h=>/\/zoekertje\//.test(h) || /\/classified\//.test(h))));
    const imgs = Array.from(document.querySelectorAll('img')).map(i=>(i as HTMLImageElement).src).filter(s=>/http/.test(s)).slice(0,8);
    const title = document.title;
    const bodyLen = document.body.innerHTML.length;
    return {title, bodyLen, listingCount: listingLinks.length, listingLinks: listingLinks.slice(0,12), imgs};
  });
  console.log(JSON.stringify(data,null,2));
  await page.close();
  await closeBrowser();
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
