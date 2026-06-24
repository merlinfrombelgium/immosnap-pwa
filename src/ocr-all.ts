import { ocrSign } from "./lib/gemini.js";
import { readdirSync } from "node:fs";
const files = readdirSync("proto").filter(f=>f.startsWith("PXL")&&f.endsWith(".jpg")).sort();
for (const f of files) {
  try { const r = await ocrSign("proto/"+f); console.log(f, "->", JSON.stringify(r)); }
  catch(e){ console.log(f, "ERR", (e as Error).message); }
}
