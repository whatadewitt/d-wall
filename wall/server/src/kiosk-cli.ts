// Run a Fully Kiosk command through the same controller the server uses, for the milestone 0 spikes.
//   docker compose exec wall-server node dist/kiosk-cli.js screenOff
//   docker compose exec wall-server node dist/kiosk-cli.js setBooleanSetting key=motionDetection value=false
//   docker compose exec wall-server node dist/kiosk-cli.js listSettings
import { loadConfig } from './config.js';
import { createKioskController } from './providers/kiosk.js';

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: kiosk-cli <cmd> [key=value ...]');
  process.exit(2);
}
const params = Object.fromEntries(rest.map((p) => p.split(/=(.*)/s, 2) as [string, string]));
const log = { info: () => {}, warn: (o: object, m: string) => console.error(m, JSON.stringify(o)) };
const kiosk = createKioskController(loadConfig().kiosk, process.env.FULLY_KIOSK_PASSWORD, log);
const started = Date.now();
const result = await kiosk.call(cmd, params);
console.log(JSON.stringify({ cmd, ms: Date.now() - started, ...result }, null, 2));
process.exit(result.ok ? 0 : 1);
