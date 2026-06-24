import { resolveImmowebAgency, getImmowebListing } from "./portals/immoweb.js";
import { closeBrowser } from "./lib/browser.js";
async function main(){
  const agency = process.argv[2] || "https://www.immoweb.be/nl/agentschap/immotijl-aalst/3608721";
  const cards = await resolveImmowebAgency(agency);
  console.log("CARDS:", cards.length);
  for(const c of cards) console.log("  ", c.url, "\n      img:", c.cardImg);
  if(cards[0]){
    console.log("\n--- DETAIL of first listing ---");
    const d = await getImmowebListing(cards.find(c=>/\/huis\//.test(c.url))?.url || cards[0].url);
    console.log(JSON.stringify({...d, images:d.images.slice(0,6), imgCount:d.images.length},null,2));
  }
  await closeBrowser();
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
