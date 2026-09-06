import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import WebSocket from 'ws';

const outputDir = process.argv[2];
if (!outputDir) throw new Error('Usage: node cdp-screencast.mjs <frames-directory>');

await mkdir(outputDir, { recursive: true });
const targets = await fetch('http://127.0.0.1:9333/json').then((response) => response.json());
const target = targets.find((item) => item.type === 'page');
if (!target?.webSocketDebuggerUrl) throw new Error('No Electron page target on CDP port 9333');

const socket = new WebSocket(target.webSocketDebuggerUrl);
let requestId = 0;
let frameNumber = 0;
let stopping = false;

function send(method, params = {}) {
  socket.send(JSON.stringify({ id: ++requestId, method, params }));
}

socket.on('open', () => {
  send('Page.startScreencast', {
    format: 'jpeg',
    quality: 82,
    maxWidth: 1320,
    maxHeight: 832,
    everyNthFrame: 1,
  });
  console.log('recording');
});

socket.on('message', async (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.method !== 'Page.screencastFrame') return;

  const file = `${outputDir}/frame-${String(++frameNumber).padStart(6, '0')}.jpg`;
  await writeFile(file, Buffer.from(message.params.data, 'base64'));
  send('Page.screencastFrameAck', { sessionId: message.params.sessionId });
});

async function stop() {
  if (stopping) return;
  stopping = true;
  send('Page.stopScreencast');
  setTimeout(() => socket.close(), 250);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
socket.on('close', () => {
  console.log(`frames=${frameNumber}`);
  process.exit(0);
});
