// One-time Spotify sign-in for the spotify provider. Run by hand on the media server:
//
//   docker compose run --rm --no-deps wall-server node dist/spotify-auth.js
//
// It prints a Spotify sign-in link. Open it on any computer or phone and approve. Spotify then
// sends the browser to http://127.0.0.1:8888/callback?code=…, which won't load: that's expected.
// Copy the whole address from the address bar, paste it here, and the script prints the refresh
// token for .env. Needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env first. Run it once per
// Spotify account in the house, signing in as that account each time.
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const ACCOUNTS = process.env.SPOTIFY_ACCOUNTS_URL ?? 'https://accounts.spotify.com';
const REDIRECT = process.env.SPOTIFY_REDIRECT_URI ?? 'http://127.0.0.1:8888/callback';
// Read what's playing and on which speaker. Nothing else: the wall never controls playback.
const SCOPES = 'user-read-playback-state user-read-currently-playing';

async function main(): Promise<void> {
  const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) {
    console.error('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in wall/.env first.');
    process.exit(2);
  }
  const state = randomBytes(12).toString('hex');
  const link = `${ACCOUNTS}/authorize?${new URLSearchParams({ client_id: id, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES, state, show_dialog: 'true' })}`;
  console.log('\n1. Open this link, sign in as the Spotify account to add, and approve.');
  console.log('   If it skips the sign-in, it is using whoever is already signed in: log out of');
  console.log('   spotify.com in that browser first, or use a private window.\n');
  console.log(`   ${link}\n`);
  console.log(`2. The browser then goes to ${REDIRECT}?code=… and shows an error. That's expected.`);
  console.log('   Copy the whole address from the address bar.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pasted = (await rl.question('3. Paste it here: ')).trim();
  rl.close();

  let url: URL;
  try {
    url = new URL(pasted);
  } catch {
    console.error('That is not an address. Run the script again.');
    process.exit(1);
  }
  if (url.searchParams.get('error')) {
    console.error(`Spotify said: ${url.searchParams.get('error')}`);
    process.exit(1);
  }
  if (url.searchParams.get('state') !== state) {
    console.error('That address is from a different sign-in. Run the script again and use the new link.');
    process.exit(1);
  }
  const code = url.searchParams.get('code');
  if (!code) {
    console.error('No code in that address. Run the script again.');
    process.exit(1);
  }

  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.refresh_token) {
    console.error(`Spotify refused the code: ${body.error_description ?? body.error ?? res.status}. Run the script again.`);
    process.exit(1);
  }
  console.log('\n4. Add this token to SPOTIFY_REFRESH_TOKENS in wall/.env. For a second account, put a comma');
  console.log('   between the tokens. Then run: docker compose up -d --force-recreate wall-server\n');
  console.log(`${body.refresh_token}\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
