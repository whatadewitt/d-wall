// One-time seed for the idle screen (spec section 8): downloads public-domain landscape paintings
// from the Google Art Project on Wikimedia Commons into the photos folder. Run by hand:
//
//   docker compose run --rm --no-deps -v "$PHOTOS_DIR:/seed" wall-server node dist/seed-art.js /seed
//
// Keeps only public-domain images at least 1,920 px wide and wider than tall. Downloads Commons'
// 3,840 px rendering, not the (often enormous) original. Writes credits.json beside the images
// with each file's title, artist, date, licence tag and Commons page. Re-running skips what is
// already there and tops the folder up to --count.
//
// Options: --count 150, --search "landscape", --category "Google Art Project works".
// SEED_CONTACT (an email address or URL) goes into the User-Agent, as Wikimedia's policy asks.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const API = process.env.COMMONS_API ?? 'https://commons.wikimedia.org/w/api.php';
const UA = `wall-display-art-seed/1.0 (personal home wall display; ${process.env.SEED_CONTACT ?? 'https://github.com/whatadewitt/d-wall'})`;
const MIN_WIDTH = 1920;
const DOWNLOAD_WIDTH = 3840; // one of Commons' standard thumbnail widths
const PAUSE_MS = 1000;       // between downloads, to be polite
const PAGE = 50;

interface Args { dir: string; count: number; search: string; category: string }

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: '', count: 150, search: 'landscape', category: 'Google Art Project works' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--count') args.count = Number(argv[++i]);
    else if (a === '--search') args.search = argv[++i] ?? '';
    else if (a === '--category') args.category = argv[++i] ?? '';
    else if (!a.startsWith('--')) args.dir = a;
  }
  if (!args.dir || !(args.count > 0)) {
    console.error('usage: seed-art <folder> [--count 150] [--search "landscape"] [--category "Google Art Project works"]');
    process.exit(2);
  }
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, attempt = 0): Promise<Response> {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'api-user-agent': UA }, signal: AbortSignal.timeout(60_000) });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const wait = Number(res.headers.get('retry-after')) * 1000 || 5000 * 2 ** attempt;
    console.error(`  server said ${res.status}; waiting ${Math.round(wait / 1000)} s`);
    await sleep(wait);
    return get(url, attempt + 1);
  }
  return res;
}

interface ImageInfo {
  width: number;
  height: number;
  mime: string;
  thumburl?: string;
  url: string;
  descriptionurl: string;
  extmetadata?: Record<string, { value?: string }>;
}
interface Page { title: string; imageinfo?: ImageInfo[] }

const plain = (html = '') =>
  html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// Public domain by its licence tag ("Public domain", "PD-Art", "PD-old-100" …) or Commons' flag.
function publicDomain(meta: ImageInfo['extmetadata']): string | null {
  const licence = plain(meta?.LicenseShortName?.value);
  if (/public domain|^pd\b|^pd-|cc0/i.test(licence)) return licence;
  if (plain(meta?.Copyrighted?.value).toLowerCase() === 'false') return licence || 'Public domain';
  return null;
}

// One page of candidates from Commons search, with what is needed to judge and fetch each.
async function candidates(args: Args, offset: number, scope: 'incategory' | 'deepcat'): Promise<{ pages: Page[]; next: number | null }> {
  const q = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrnamespace: '6',
    gsrlimit: String(PAGE),
    gsroffset: String(offset),
    gsrsearch: `filetype:bitmap ${scope}:"${args.category}" ${args.search}`.trim(),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: String(DOWNLOAD_WIDTH),
    iiextmetadatafilter: 'LicenseShortName|Copyrighted|Artist|ObjectName|DateTimeOriginal',
  });
  const res = await get(`${API}?${q}`);
  if (!res.ok) throw new Error(`Commons search: HTTP ${res.status}`);
  const body = (await res.json()) as { query?: { pages?: Page[] }; continue?: { gsroffset?: number } };
  return { pages: body.query?.pages ?? [], next: body.continue?.gsroffset ?? null };
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'art';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.dir, { recursive: true });
  const creditsPath = join(args.dir, 'credits.json');
  let credits: Record<string, { title: string; artist: string; date: string; licence: string; source: string }> = {};
  try {
    credits = JSON.parse(await readFile(creditsPath, 'utf8'));
  } catch {
    // first run
  }
  const have = new Set(Object.values(credits).map((c) => c.source));
  let files = (await readdir(args.dir)).filter((n) => n !== 'credits.json').length;
  console.log(`${files} images already in the folder; aiming for ${args.count}.`);

  let offset: number | null = 0;
  let checked = 0;
  let skipped = 0;
  // Files directly in the category first; if it holds none (only subcategories), search the tree.
  let scope: 'incategory' | 'deepcat' = 'incategory';
  while (files < args.count && offset !== null) {
    const page = await candidates(args, offset, scope);
    if (!page.pages.length && offset === 0 && scope === 'incategory') {
      console.log('No files directly in the category; searching its subcategories too.');
      scope = 'deepcat';
      continue;
    }
    offset = page.next;
    for (const p of page.pages) {
      if (files >= args.count) break;
      checked++;
      const info = p.imageinfo?.[0];
      if (!info || have.has(info.descriptionurl)) continue;
      const licence = publicDomain(info.extmetadata);
      if (!licence || info.width < MIN_WIDTH || info.width <= info.height) {
        skipped++;
        continue;
      }
      const url = info.thumburl ?? info.url;
      const res = await get(url);
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !/^image\/(jpeg|png)/.test(type)) {
        skipped++;
        await sleep(PAUSE_MS);
        continue;
      }
      const meta = info.extmetadata ?? {};
      const title = plain(meta.ObjectName?.value) || p.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '');
      const name = `${String(files + 1).padStart(3, '0')}-${slug(title)}.${type.includes('png') ? 'png' : 'jpg'}`;
      await writeFile(join(args.dir, name), Buffer.from(await res.arrayBuffer()));
      credits[name] = {
        title,
        artist: plain(meta.Artist?.value),
        date: plain(meta.DateTimeOriginal?.value).slice(0, 40),
        licence,
        source: info.descriptionurl,
      };
      have.add(info.descriptionurl);
      files++;
      await writeFile(creditsPath, JSON.stringify(credits, null, 2));
      if (files % 10 === 0) console.log(`  ${files} of ${args.count}`);
      await sleep(PAUSE_MS);
    }
  }
  console.log(`Done: ${files} images in the folder (${checked} candidates checked, ${skipped} skipped).`);
  if (files < args.count) console.log('Ran out of search results. Try --search with another word, such as "river" or "sea".');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
