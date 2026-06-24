import { renderPage, closeBrowser } from "./lib/browser.js";
import { fetchImage } from "./lib/imageMatch.js";
import sharp from "sharp";
async function main(){
  const d = await renderPage("https://www.spotto.be/nl/p/te-koop/9200-dendermonde/huis-schuurkouter-31-met-3-kamers-tuin-terras/2eSh3EDUGEmJ4gjeWsbYcg",{settle:3500,retries:3,timeout:50000,scroll:5});
  const uuids=Array.from(new Set((d.html.match(/file\.immo-connect\.be\/image\/([a-f0-9-]{36})/gi)||[]).map(s=>s.split("/image/")[1])));
  const urls = uuids.map(u=>`https://file.immo-connect.be/image/${u}?width=500&fileformat=jpeg`);
  const bufs=(await Promise.all(urls.map(u=>fetchImage(u,300)))).filter(Boolean) as Buffer[];
  // montage 4 cols
  const cols=4, tw=300, th=225, rows=Math.ceil(bufs.length/cols);
  const comp:any[]=[];
  for(let i=0;i<bufs.length;i++){
    const t=await sharp(bufs[i]).resize({width:tw,height:th,fit:"contain",background:{r:240,g:240,b:240}}).toBuffer();
    comp.push({input:t,left:(i%cols)*tw,top:Math.floor(i/cols)*th});
    const lbl=Buffer.from(`<svg width="40" height="26"><rect width="40" height="26" fill="#000" opacity="0.6"/><text x="4" y="20" font-size="20" fill="#fff" font-family="Arial">${i+1}</text></svg>`);
    comp.push({input:lbl,left:(i%cols)*tw+2,top:Math.floor(i/cols)*th+2});
  }
  await sharp({create:{width:cols*tw,height:rows*th,channels:3,background:{r:255,g:255,b:255}}}).composite(comp).jpeg({quality:80}).toFile("/tmp/schuurkouter_all.jpg");
  console.log("saved /tmp/schuurkouter_all.jpg with",bufs.length,"imgs");
  await closeBrowser();
}
main().catch(e=>{console.error(e);process.exit(1);});
