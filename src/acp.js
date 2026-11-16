const path = require('node:path');
const { spawn } = require('node:child_process');
const LIMIT = 65536;
const unavailable = () => new Error('Assigned Visor session unavailable; the request was not retried.');

// Only an explicit user configuration selects the installed adapter and socket.
// Prompt text stays on stdin; neither credentials nor project commands are used.
async function chat({ executable, socket, cwd, prompt, signal, spawnProcess = spawn, timeout = 35000 }) {
  if (![executable, socket, cwd].every(v => typeof v === 'string' && path.isAbsolute(v) && !/[\r\n\0]/.test(v)) ||
      typeof prompt !== 'string' || !prompt || Buffer.byteLength(prompt) > LIMIT || signal?.aborted) throw unavailable();
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'LANG']) if (process.env[key]) env[key] = process.env[key];
  const child = spawnProcess(executable, ['--visor-socket', socket], { cwd, shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending, sequence = 0, session, output = '', buffer = Buffer.alloc(0), closed = false;
  const fail = () => { closed = true; if (pending) { const p = pending; pending = undefined; p.reject(unavailable()); } child.kill(); };
  const cancel = () => {
    if (session && !closed) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: session } }) + '\n');
    fail();
  };
  const timer = setTimeout(cancel, timeout);
  signal?.addEventListener('abort', cancel, { once: true });
  child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
  // Never forward backend diagnostics, which may contain sensitive input.
  child.stderr.on('data', () => {});
  child.stdout.on('data', data => {
    if (closed) return;
    buffer = Buffer.concat([buffer, data]);
    if (buffer.length > 524288) return fail();
    let end;
    while ((end = buffer.indexOf(10)) >= 0 && !closed) {
      const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      let message;
      try { message = JSON.parse(line.toString('utf8')); } catch { return fail(); }
      if (message?.jsonrpc !== '2.0') return fail();
      if (message.method === 'session/update') {
        const p = message.params, update = p?.update;
        if (!session || p.sessionId !== session || update?.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text' || typeof update.content.text !== 'string') return fail();
        output += update.content.text;
        if (Buffer.byteLength(output) > LIMIT) return fail();
      } else if (pending && message.id === pending.id && !message.method) {
        const p = pending; pending = undefined;
        if (message.error || !message.result) { p.reject(unavailable()); return fail(); }
        p.resolve(message.result);
      } else return fail();
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed || pending) return reject(unavailable());
    const id = ++sequence; pending = { id, resolve, reject };
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'hypermesh-vscode', version: '0.1.0' } });
    if (init.protocolVersion !== 1) throw unavailable();
    const opened = await request('session/new', { cwd, mcpServers: [] });
    if (typeof opened.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(opened.sessionId)) throw unavailable();
    session = opened.sessionId;
    const result = await request('session/prompt', { sessionId: session, prompt: [{ type: 'text', text: prompt }] });
    if (result.stopReason !== 'end_turn') throw unavailable();
    return output;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    closed = true; child.stdin.end(); child.kill();
  }
}
module.exports = { chat };
