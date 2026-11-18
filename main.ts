// main.ts -- the forge's process shell.
//
// The forge itself lives in app.ts: createApp() builds its HTTP server. This
// file owns only the handshake with the harness env around that server:
//
//   1. read the env's origin from MAKEFUN_ENV_URL;
//   2. start the forge on a port the kernel picks;
//   3. tell the env which port we took (POST /register);
//   4. wait until the env reports the trial is over (GET /done);
//   5. close the forge and exit 0.
//
// The env is the clock for the whole run: this process never decides on its
// own that the trial has ended, and it does not give up when the env is slow
// or briefly unreachable -- a failed handshake step is retried after a
// doubling pause until it lands.

import { createApp } from './app.ts';
import type { Server } from 'node:http';

/** One handshake request may hang at most this long before it is retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first pause between two attempts of one step. */
const FIRST_PAUSE_MS = 250;
/** The pause between attempts never grows past this. */
const LONGEST_PAUSE_MS = 2_000;

/** Sleep for `ms` milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The pause after `failures` attempts in a row did not land: doubling, capped. */
function pauseAfter(failures: number): number {
  return Math.min(LONGEST_PAUSE_MS, FIRST_PAUSE_MS * 2 ** failures);
}

/** The env's origin, trailing slashes stripped; a missing value is fatal. */
function envOrigin(): string {
  const origin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (origin === '') {
    console.error('main: MAKEFUN_ENV_URL is not set, so there is no harness env to register with');
    process.exit(1);
  }
  return origin;
}

/** Start `server` on a kernel-picked port and resolve with the port taken. */
function bindEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('main: the forge listener reports no port'));
        return;
      }
      resolve(address.port);
    });
  });
}

/**
 * POST our port to the env until the registration lands.
 *
 * A 200 means we are the entry the env will test. A 409 means another entry
 * registered first and keeps that place; our remaining job is unchanged --
 * wait for the end of the trial -- so both answers end this step. A 400 or
 * 405 means the request itself breaks the contract, which no retry can fix,
 * so the process exits non-zero at once. Anything else (a refused
 * connection, a timeout, an unexpected status) is retried after a growing
 * pause.
 */
async function registerWithEnv(origin: string, port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let status: number | null = null;
    try {
      const reply = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = reply.status;
      await reply.text().catch(() => undefined); // drain the body, freeing the socket
    } catch {
      status = null; // the request never landed; the retry below covers it
    }
    if (status === 200 || status === 409) return;
    if (status === 400 || status === 405) {
      console.error(`main: the env answered the registration with ${status}, a contract error; exiting`);
      process.exit(1);
    }
    await pause(pauseAfter(failures));
    failures += 1;
  }
}

/**
 * Poll the env's /done until it answers {"done": true}. A poll that fails,
 * times out, or answers anything else is not the end of the trial: pause and
 * ask again, for as long as it takes.
 */
async function waitUntilDone(origin: string): Promise<void> {
  let polls = 0;
  for (;;) {
    let done = false;
    try {
      const reply = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (reply.ok) {
        const body: unknown = await reply.json();
        done = typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true;
      }
    } catch {
      done = false;
    }
    if (done) return;
    await pause(pauseAfter(polls));
    polls += 1;
  }
}

/**
 * Close the listener and wait until it has let go of its connections. Idle
 * keep-alive sockets are dropped at once; the grace timer keeps one stubborn
 * connection from holding the process open past the end of the trial.
 */
function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    const grace = setTimeout(resolve, 5_000);
    server.close(() => {
      clearTimeout(grace);
      resolve();
    });
    server.closeIdleConnections();
  });
}

/** The whole lifecycle, in order. */
async function main(): Promise<void> {
  const origin = envOrigin();
  const server = createApp();
  const port = await bindEphemeral(server);
  await registerWithEnv(origin, port);
  await waitUntilDone(origin);
  await stopServer(server);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('main: the lifecycle failed:', error);
    process.exit(1);
  },
);
