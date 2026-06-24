import { renderPage, closeBrowser } from "./lib/browser.js";
import { prepImage } from "./lib/gemini.js";
import { scoreCandidate, fetchImage } from "./lib/imageMatch.js";
import sharp from "sharp";
async function main(){
  const l = await renderPage("https://immolot.be/te-koop/5944575/huis-in-Dendermonde/",{settle:3500,retries:2,timeout:55000,scroll:5});
  const imgs=Array.from(new Set((l.html.match(/https?:\/\/r2\.storagewhise\.eu\/[^"'\s)]+?\/1600\/[^"'\s)]+?\.jpg/gi)||[])));
  console.log("Schuurkouter REAL images:", imgs.length);
  // montage of first 12 to view
  const bufs=(await Promise.all(imgs.slice(0,12).map(u=>fetchImage(u,300)))).filter(Boolean) as Buffer[];
  const cols=4,tw=300,th=225,rows=Math.ceil(bufs.length/cols);const comp:any[]=[];
  for(let i=0;i<bufs.length;i++){const t=await sharp(bufs[i]).resize({width:tw,height:th,fit:"contain",background:{r:240,g:240,b:240}}).toBuffer();comp.push({input:t,left:(i%cols)*tw,top:Math.floor(i/cols)*th});const lbl=Buffer.from(`<svg width="40" height="26"><rect width="40" height="26" fill="#000" opacity="0.6"/><text x="4" y="20" font-size="20" fill="#fff">${i+1}</text></svg>`);comp.push({input:lbl,left:(i%cols)*tw+2,top:Math.floor(i/cols)*th+2});}
  await sharp({create:{width:cols*tw,height:rows*th,channels:3,background:{r:255,g:255,b:255}}}).composite(comp).jpeg({quality:80}).toFile("/tmp/schuur_real.jpg");
  const queryB64 = await prepImage("proto/PXL_20260215_104544364.jpg", 1100);
  const r = await scoreCandidate(queryB64, imgs, 9);
  console.log("FACADE MATCH photo2 vs Schuurkouter:", JSON.stringify(r,null,2));
  await closeBrowser();
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
