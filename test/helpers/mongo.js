// Starts a real mongod on a random free port with a temp dbpath. Never mocks Mongo.
//   const m = await startMongo();   // { uri, client, db, dbName, stop() }
//   ... use m.db (a Db with a unique name), or m.client.db('other') ...
//   await m.stop();                 // closes the client, kills mongod, removes the dbpath
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';

export const MONGOD_BIN = process.env.MONGOD_BIN ||
  (existsSync('/home/claude/tools/mongod') ? '/home/claude/tools/mongod' : 'mongod');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startMongo({ dbName } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const dbpath = await mkdtemp(path.join(os.tmpdir(), 'oss-status-mongo-'));
    const proc = spawn(MONGOD_BIN, ['--port', String(port), '--dbpath', dbpath, '--bind_ip', '127.0.0.1',
      '--nounixsocket', '--quiet', '--wiredTigerCacheSizeGB', '0.25'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let exited = false;
    let output = '';
    proc.stdout.on('data', (d) => { if (output.length < 4000) output += d; });
    proc.stderr.on('data', (d) => { if (output.length < 4000) output += d; });
    proc.on('exit', () => { exited = true; });
    proc.on('error', (e) => { exited = true; lastErr = e; });
    const uri = `mongodb://127.0.0.1:${port}`;
    let client = null;
    const deadline = Date.now() + 30000;
    while (!exited && Date.now() < deadline) {
      try {
        const c = new MongoClient(uri, { serverSelectionTimeoutMS: 500 });
        await c.connect();
        await c.db('admin').command({ ping: 1 });
        client = c;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const cleanup = async () => {
      if (!exited) {
        await new Promise((resolve) => { proc.once('exit', resolve); proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), 5000).unref(); });
      }
      await rm(dbpath, { recursive: true, force: true }).catch(() => {});
    };
    if (!client) {
      await cleanup();
      lastErr = new Error(`mongod did not start: ${lastErr?.message || ''} ${output.slice(0, 500)}`);
      continue;
    }
    const name = dbName || `test_${Math.random().toString(16).slice(2, 10)}`;
    return {
      uri, port, client, dbName: name, db: client.db(name),
      async stop() { await client.close().catch(() => {}); await cleanup(); },
    };
  }
  throw lastErr;
}
