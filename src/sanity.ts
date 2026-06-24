import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { closeBrowser } from "./lib/browser.js";
import { matchImage } from "./lib/matcher.js";

async function main() {
  const protoDir = resolve(process.cwd(), "proto");
  const files = (await readdir(protoDir))
    .filter((name) => /^PXL_.*\.jpg$/i.test(name))
    .sort();

  const results = [];
  for (const file of files) {
    console.error(`[sanity] matching ${file}`);
    const imageBuffer = await readFile(resolve(protoDir, file));
    const result = await matchImage({ imageBuffer, maxCandidates: 4 });
    results.push({
      file,
      agency: result.agency,
      phone: result.phone,
      town: result.town,
      candidateCount: result.candidates.length,
      topCandidates: result.candidates.slice(0, 3),
    });
  }

  console.log(JSON.stringify(results, null, 2));
}

main()
  .then(() => closeBrowser())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(error);
    await closeBrowser().catch(() => {});
    process.exit(1);
  });
