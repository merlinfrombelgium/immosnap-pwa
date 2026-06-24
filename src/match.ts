import { readFile } from "node:fs/promises";
import { closeBrowser } from "./lib/browser.js";
import { matchImage } from "./lib/matcher.js";

interface Args {
  image: string;
  gps?: { lat: number; lon: number } | null;
  max: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { image: "", gps: null, max: 8 };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--gps") {
      const value = argv[++i] || "";
      const [lat, lon] = value.split(",").map((part) => Number(part.trim()));
      if (Number.isFinite(lat) && Number.isFinite(lon)) args.gps = { lat, lon };
    } else if (token === "--max") {
      args.max = parseInt(argv[++i] || "", 10) || 8;
    } else if (!args.image) {
      args.image = token;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.image) {
    console.error("usage: npm run match -- <image-path> [--gps lat,lon] [--max N]");
    process.exit(1);
  }

  const imageBuffer = await readFile(args.image);
  const result = await matchImage({
    imageBuffer,
    gps: args.gps,
    maxCandidates: args.max,
  });

  console.log(
    JSON.stringify(
      {
        query: {
          agency: result.agency,
          phone: result.phone,
          town: result.town,
          website: result.website,
          ref: result.ref,
          text: result.text,
        },
        image: args.image,
        candidates: result.candidates,
      },
      null,
      2
    )
  );
}

main()
  .then(() => closeBrowser())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(error);
    await closeBrowser().catch(() => {});
    process.exit(1);
  });
