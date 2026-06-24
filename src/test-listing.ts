import { getBrowser, closeBrowser, sleep } from "./lib/browser.js";
async function main(){
  const url = process.argv[2] || "https://www.immoweb.be/nl/zoekertje/huis/te-koop/aalst-hofstade/9308/21652970";
  const b = await getBrowser(); const page = await b.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  await page.goto(url,{waitUntil:"domcontentloaded",timeout:45000});
  await sleep(3000);
  const d = await page.evaluate(()=>{
    const og=(p:string)=>document.querySelector(`meta[property="og:${p}"]`)?.getAttribute("content")||null;
    // immoweb stores data in window.classified or a script
    let classified:any=null;
    try { classified=(window as any).classified || null; } catch(e){}
    // search scripts for JSON with mediaCollection
    let imgs:string[]=[];
    let addr:any=null, price:any=null;
    const scripts=Array.from(document.querySelectorAll('script'));
    for(const s of scripts){
      const t=s.textContent||"";
      if(t.includes('"classified"')&&t.includes('media')){
        const m=t.match(/window\.classified\s*=\s*(\{[\s\S]*?\});/);
        if(m){ try{ const j=JSON.parse(m[1]); classified=j; }catch(e){} }
      }
    }
    if(classified){
      try{
        const media=classified.media?.pictures||[];
        imgs=media.map((p:any)=>p.largeUrl||p.mediumUrl||p.url).filter(Boolean);
        addr=classified.property?.location;
        price=classified.price?.mainValue||classified.transaction?.sale?.price;
      }catch(e){}
    }
    // fallback: gather gallery imgs from DOM
    const domImgs=Array.from(document.querySelectorAll('img')).map(i=>(i as HTMLImageElement).src).filter(s=>/classifieds\//.test(s));
    return {title:og("title"),ogImage:og("image"),hasClassified:!!classified, addr, price, jsonImgCount:imgs.length, jsonImgs:imgs.slice(0,12), domImgs:Array.from(new Set(domImgs)).slice(0,12)};
  });
  console.log(JSON.stringify(d,null,2));
  await page.close(); await closeBrowser();
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
