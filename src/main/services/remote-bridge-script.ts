export const REMOTE_DETACHED_BRIDGE_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

function safeUnlink(target) {
  try {
    fs.unlinkSync(target);
  } catch {}
}

function safeWrite(stream, chunk) {
  try {
    stream.write(chunk);
  } catch {}
}

function parseConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

function runSpawn(configPath) {
  const config = parseConfig(configPath);
  fs.mkdirSync(config.jobDir, { recursive: true });
  safeUnlink(config.socketPath);
  safeUnlink(config.eofPath);
  safeUnlink(config.exitPath);
  safeUnlink(config.pidPath);

  const logStream = fs.createWriteStream(config.logPath, { flags: 'a' });
  const child = spawn(config.command, config.args, {
    cwd: config.cwd,
    env: { ...process.env, ...config.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  fs.writeFileSync(config.pidPath, String(child.pid || ''));

  let finalized = false;
  let stdinClosed = false;
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('data', (chunk) => {
      if (!stdinClosed && child.stdin && !child.stdin.destroyed) {
        child.stdin.write(chunk);
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('end', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  const finalize = (code, signal, errorMessage) => {
    if (finalized) return;
    finalized = true;
    clearInterval(eofPoller);

    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {}
    }

    try {
      server.close(() => safeUnlink(config.socketPath));
    } catch {
      safeUnlink(config.socketPath);
    }

    const payload = {
      code,
      signal,
      error: errorMessage || null,
      exitedAt: new Date().toISOString(),
    };

    logStream.end(() => {
      try {
        fs.writeFileSync(config.exitPath, JSON.stringify(payload));
      } catch {}
      process.exit(0);
    });
  };

  const eofPoller = setInterval(() => {
    if (stdinClosed || !child.stdin || child.stdin.destroyed) return;
    if (!fs.existsSync(config.eofPath)) return;
    stdinClosed = true;
    safeUnlink(config.eofPath);
    try {
      child.stdin.end();
    } catch {}
  }, 200);
  eofPoller.unref();

  server.on('error', (error) => {
    safeWrite(logStream, Buffer.from('[bridge-server-error] ' + (error && error.stack ? error.stack : String(error)) + '\n'));
    finalize(1, null, error instanceof Error ? error.message : String(error));
  });

  child.stdout.on('data', (chunk) => safeWrite(logStream, chunk));
  child.stderr.on('data', (chunk) => safeWrite(logStream, chunk));

  child.on('error', (error) => {
    safeWrite(logStream, Buffer.from('[bridge-child-error] ' + (error && error.stack ? error.stack : String(error)) + '\n'));
    finalize(1, null, error instanceof Error ? error.message : String(error));
  });

  child.on('exit', (code, signal) => {
    finalize(code, signal, null);
  });

  server.listen(config.socketPath);

  const terminateChild = () => {
    try {
      child.kill('SIGTERM');
    } catch {}
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGTERM', terminateChild);
  process.on('SIGINT', terminateChild);
}

function runStdin(socketPath) {
  const socket = net.createConnection(socketPath);
  socket.on('connect', () => {
    process.stdout.write('[stdin-ready]\n');
  });
  socket.on('error', (error) => {
    process.stderr.write(String(error instanceof Error ? error.message : error));
    process.exit(1);
  });
  socket.on('close', () => process.exit(0));
  process.stdin.pipe(socket);
}

const mode = process.argv[2];
if (mode === 'spawn') {
  const configPath = process.argv[3];
  if (!configPath) {
    process.stderr.write('Missing config path\n');
    process.exit(1);
  }
  runSpawn(configPath);
} else if (mode === 'stdin') {
  const socketPath = process.argv[3];
  if (!socketPath) {
    process.stderr.write('Missing socket path\n');
    process.exit(1);
  }
  runStdin(socketPath);
} else {
  process.stderr.write('Unknown mode\n');
  process.exit(1);
}
`;
