import { spawn } from 'node:child_process';
import process from 'node:process';

console.log('🚀 Starting Woofy Backend Server (:4310)...');

const server = spawn(
  'node',
  ['--env-file-if-exists=.env', 'node_modules/tsx/dist/cli.mjs', 'src/server/index.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  },
);

console.log('⚡ Starting Woofy Frontend Vite (:5173)...');

const vite = spawn(
  'node',
  ['node_modules/vite/bin/vite.js'],
  {
    stdio: 'inherit',
    env: process.env,
  },
);

function shutdown() {
  try {
    server.kill();
  } catch {}
  try {
    vite.kill();
  } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('exit', (code) => {
  if (code && code !== 0) {
    console.error(`Server process exited with code ${code}`);
  }
});

vite.on('exit', (code) => {
  if (code && code !== 0) {
    console.error(`Vite process exited with code ${code}`);
  }
});
