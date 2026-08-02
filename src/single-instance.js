import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.bot.lock');

function alive(pid) {
  try {
    process.kill(pid, 0); // signal 0 tests existence without touching the process
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, just not ours to signal
  }
}

/**
 * Refuse to start if another copy is already running.
 *
 * Discord delivers each interaction to every connected instance and allows only
 * one voice session per bot per guild, so a second process makes the bot fail
 * in confusing ways: "Unknown interaction" errors and voice connections that
 * never become Ready.
 */
export function claimSingleInstance() {
  if (fs.existsSync(LOCK)) {
    const pid = Number.parseInt(fs.readFileSync(LOCK, 'utf8').trim(), 10);
    if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) {
      console.error(
        `\n❌ This bot is already running (pid ${pid}).\n` +
          '   Running two copies breaks slash commands and voice.\n' +
          `   Stop the other one first, or: taskkill /PID ${pid} /F\n`,
      );
      process.exit(1);
    }
    fs.rmSync(LOCK, { force: true }); // stale lock from a crash
  }

  fs.writeFileSync(LOCK, String(process.pid));

  // 'exit' fires on normal exit, process.exit(), and uncaught exceptions alike,
  // so it is the only hook needed to clean up the lock.
  const release = () => fs.rmSync(LOCK, { force: true });
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
}
