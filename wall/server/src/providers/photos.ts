import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import sharp from 'sharp';
import type { Provider, ProviderDeps } from './types.js';

// The photos provider (spec section 8): the idle screen's images. A PhotoSource lists and reads
// originals; the provider serves them one at a time in shuffled order, resized to the tablet's
// screen and cached on disk (the last 20). The client never receives an original. Photo names
// never reach the log.

const RESCAN_MS = 30 * 60_000;
const CACHE_KEEP = 20;
const DEFAULT_SIZE = { w: 2560, h: 1600 }; // the Pixel Tablet's screen in device pixels
const JPEG_QUALITY = 82;
const MAX_INPUT_PIXELS = 120_000_000; // about 13,000 × 9,000; larger originals are skipped
const CACHE_FILE = /^[0-9a-f]{16}-\d+x\d+\.jpg$/;
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff']);

export interface Photo {
  id: string;        // stable for a file and its contents, safe to log
  caption?: { title: string; credit: string };
}

export interface PhotoSource {
  name: string;
  list(): Promise<Photo[]>;
  read(photo: Photo): Promise<Buffer>;
}

interface Credit { title?: string; artist?: string; date?: string }

// Image files under a folder, rescanned every 30 minutes. An optional credits.json beside them
// (written by the art seed script) maps a file name to its title, artist and date.
function folderSource(dir: string): PhotoSource {
  const paths = new Map<string, string>();
  return {
    name: 'folder',
    async list() {
      const names = (await readdir(dir, { recursive: true })).filter((n) => IMAGE_EXT.has(extname(n).toLowerCase()));
      let credits: Record<string, Credit> = {};
      try {
        credits = JSON.parse(await readFile(join(dir, 'credits.json'), 'utf8')) as Record<string, Credit>;
      } catch {
        // no credits file: no captions
      }
      paths.clear();
      const photos: Photo[] = [];
      for (const name of names) {
        const path = join(dir, name);
        const s = await stat(path).catch(() => null);
        if (!s?.isFile()) continue;
        const id = createHash('sha256').update(`${relative(dir, path)}\0${s.size}\0${s.mtimeMs}`).digest('hex').slice(0, 16);
        paths.set(id, path);
        const c = credits[name];
        const credit = [c?.artist, c?.date].filter(Boolean).join(', ');
        photos.push({ id, caption: c?.title ? { title: c.title, credit } : undefined });
      }
      return photos;
    },
    async read(photo) {
      const path = paths.get(photo.id);
      if (!path) throw new Error('photo gone');
      return readFile(path);
    },
  };
}

const shuffle = <T>(a: T[]): T[] => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export function photosProvider({ config, log }: ProviderDeps): Provider {
  const source = folderSource(config.photos?.path ?? '');
  const cacheDir = process.env.PHOTOS_CACHE_DIR ?? '/tmp/wall-photos';
  let photos: Photo[] = [];
  let queue: Photo[] = [];
  const cached: string[] = []; // cache file names, oldest first
  const resizing = new Map<string, Promise<Buffer>>();
  const bad = new Set<string>(); // ids that failed to resize; a changed file gets a new id
  let timer: NodeJS.Timeout | undefined;

  // Small and steady memory use in a 512 MB container: one resize at a time, no libvips cache.
  sharp.concurrency(1);
  sharp.cache(false);

  async function scan(): Promise<void> {
    try {
      photos = (await source.list()).filter((p) => !bad.has(p.id));
      const known = new Set(photos.map((p) => p.id));
      queue = queue.filter((p) => known.has(p.id));
      log.info({ photos: photos.length, captions: photos.filter((p) => p.caption).length }, 'photos: folder scanned');
      if (!photos.length) log.warn({ photos: 0 }, 'photos: no images in the photos folder; run the art seed script (milestone 4 report)');
    } catch (err) {
      log.warn({ error: err instanceof Error ? (err as NodeJS.ErrnoException).code ?? err.message : String(err) }, 'photos: cannot read the photos folder');
    }
  }

  // The next photo in shuffled order. A new shuffle starts when the queue runs out, never with
  // the photo that was just shown.
  function next(): Photo | null {
    if (!photos.length) return null;
    if (!queue.length) {
      const last = photos.length > 1 ? queue.at(-1) : undefined;
      queue = shuffle([...photos]);
      if (last && queue[0].id === last.id) queue.push(queue.shift()!);
    }
    return queue.shift() ?? null;
  }

  // Landscape originals fill the screen (cover); portrait ones keep their shape (inside), and the
  // client centres them on black.
  function resized(photo: Photo, w: number, h: number): Promise<Buffer> {
    const key = `${photo.id}-${w}x${h}.jpg`;
    const pending = resizing.get(key);
    if (pending) return pending;
    const job = (async () => {
      try {
        return await readFile(join(cacheDir, key));
      } catch {
        // not cached yet
      }
      const img = sharp(await source.read(photo), { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
      const meta = await img.metadata();
      const swap = (meta.orientation ?? 1) >= 5; // EXIF rotations by 90°
      const width = (swap ? meta.height : meta.width) ?? 0;
      const height = (swap ? meta.width : meta.height) ?? 0;
      const landscape = width >= height;
      const jpeg = await img
        .resize({ width: w, height: h, fit: landscape ? 'cover' : 'inside' })
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
      await mkdir(cacheDir, { recursive: true });
      await writeFile(join(cacheDir, key), jpeg);
      cached.push(key);
      while (cached.length > CACHE_KEEP) await rm(join(cacheDir, cached.shift()!), { force: true });
      return jpeg;
    })().finally(() => resizing.delete(key));
    resizing.set(key, job);
    return job;
  }

  return {
    id: 'photos',
    topics: [],
    routes(app) {
      // w and h are the screen in device pixels; the client sends them.
      app.get<{ Querystring: { w?: number; h?: number } }>('/api/photos/next', {
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: { w: { type: 'integer' }, h: { type: 'integer' } },
          },
        },
      }, async (req, reply) => {
        const w = clamp(req.query.w ?? DEFAULT_SIZE.w, 320, 3840);
        const h = clamp(req.query.h ?? DEFAULT_SIZE.h, 240, 3840);
        for (let attempt = 0; attempt < 3; attempt++) {
          const photo = next();
          if (!photo) return reply.code(404).send({ error: 'no photos' });
          const started = Date.now();
          try {
            const jpeg = await resized(photo, w, h);
            log.debug({ photo: photo.id, ms: Date.now() - started, kb: Math.round(jpeg.length / 1024) }, 'photo served');
            // Resize the one after now, so the next request is answered from disk.
            const after = queue[0];
            if (after) void resized(after, w, h).catch(() => {});
            reply.header('cache-control', 'no-store');
            if (photo.caption) {
              reply.header('x-photo-title', encodeURIComponent(photo.caption.title));
              reply.header('x-photo-credit', encodeURIComponent(photo.caption.credit));
            }
            return reply.type('image/jpeg').send(jpeg);
          } catch (err) {
            // A file system error's message holds the path, so log only its code.
            const e = err as NodeJS.ErrnoException;
            bad.add(photo.id);
            photos = photos.filter((p) => p.id !== photo.id);
            queue = queue.filter((p) => p.id !== photo.id);
            log.warn({ photo: photo.id, error: e?.code ?? (e instanceof Error ? e.message : String(err)) }, 'photos: could not resize; skipped');
          }
        }
        return reply.code(503).send({ error: 'no usable photo' });
      });
    },
    async start() {
      if (!config.photos?.path) {
        log.warn({ photos: 'disabled' }, 'photos: set photos.path in config.yaml');
        return;
      }
      // Leftovers from an earlier run are not tracked, so start the cache empty (our files only).
      for (const name of await readdir(cacheDir).catch(() => [] as string[])) {
        if (CACHE_FILE.test(name)) await rm(join(cacheDir, name), { force: true });
      }
      await scan();
      timer = setInterval(() => void scan(), RESCAN_MS);
    },
    stop() {
      clearInterval(timer);
    },
  };
}
