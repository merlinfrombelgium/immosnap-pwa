import { readFile } from "node:fs/promises";
import { closeBrowser } from "./lib/browser.js";
import { matchImage } from "./lib/matcher.js";
import { readExifGps } from "./lib/geo.js";

interface Args {
  image: string;
  gps?: { lat: number; lon: number } | null;
  town?: string | null;
  max: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { image: "", gps: null, town: null, max: 8 };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--gps") {
      const value = argv[++i] || "";
      const [lat, lon] = value.split(",").map((part) => Number(part.trim()));
      if (Number.isFinite(lat) && Number.isFinite(lon)) args.gps = { lat, lon };
    } else if (token === "--town") {
      args.town = argv[++i] || null;
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
    console.error("usage: npm run match -- <image-path> [--gps lat,lon] [--town Town] [--max N]");
    process.exit(1);
  }

  const imageBuffer = await readFile(args.image);
  // Auto-read EXIF GPS from the file when --gps was not supplied (the `(1)` proto
  // copies carry GPS). The server gets device GPS from the client instead.
  let gps = args.gps;
  if (!gps) {
    gps = await readExifGps(args.image);
    if (gps) console.error(`[match] using EXIF GPS ${gps.lat},${gps.lon}`);
  }

  const result = await matchImage({
    imageBuffer,
    gps,
    town: args.town,
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
        matchKind: result.matchKind,
        debug: result.debug,
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
