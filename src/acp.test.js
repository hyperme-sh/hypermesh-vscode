const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { chat } = require('./acp');
const path = require('node:path');
const session = '11111111-1111-4111-8111-111111111111';
function fixture(change = () => {}) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const requests = []; let killed = 0;
  child.kill = () => { killed++; };
  child.stdin = new Writable({ write(raw, _, done) {
    const m = JSON.parse(raw); requests.push(m);
    queueMicrotask(() => {
      let result = m.method === 'initialize' ? { protocolVersion: 1 } : m.method === 'session/new' ? { sessionId: session } : { stopReason: 'end_turn' };
      const send = value => child.stdout.write(JSON.stringify(value) + '\n');
      if (m.method === 'session/prompt') send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } } } });
      change(m, child, result);
      if (m.id) send({ jsonrpc: '2.0', id: m.id, result });
    }); done();
  } });
  const options = { executable: path.resolve('/installed/hypermesh-acp'), socket: path.resolve('/private/visor.sock'), cwd: path.resolve('/project'), prompt: 'private prompt', spawnProcess(exe, args, config) {
    assert.equal(config.shell, false); assert.deepEqual(args, ['--visor-socket', options.socket]); assert(!JSON.stringify(args).includes(options.prompt)); return child;
  } };
  return { options, requests, killed: () => killed };
}
test('assigned ACP turn uses stdin without importing project MCP settings', async () => {
  const f = fixture(); assert.equal(await chat(f.options), 'answer');
  assert.deepEqual(f.requests[1].params.mcpServers, []); assert.equal(f.killed(), 1);
});
test('unknown outcome is not retried and diagnostics remain private', async () => {
  const f = fixture((m, child) => { if (m.method === 'session/prompt') child.emit('error', new Error('secret token')); });
  await assert.rejects(chat(f.options), /not retried/); assert.equal(f.requests.filter(m => m.method === 'session/prompt').length, 1);
});
test('cancellation reaches assigned session and stops the process', async () => {
  const abort = new AbortController(); const f = fixture(m => { if (m.method === 'session/prompt') abort.abort(); });
  await assert.rejects(chat({ ...f.options, signal: abort.signal })); assert(f.requests.some(m => m.method === 'session/cancel')); assert(f.killed() > 0);
});
test('relative executable and oversized prompt are refused before spawn', async () => {
  const f = fixture(); await assert.rejects(chat({ ...f.options, executable: './project-script' })); await assert.rejects(chat({ ...f.options, prompt: 'x'.repeat(65537) })); assert.equal(f.requests.length, 0);
});

test('escaped decoded prompt remains within the ACP wire bound', async () => {
 const f = fixture(); f.options.prompt = '\n'.repeat(50000);
 assert.equal(await chat(f.options), 'answer');
 assert.equal(f.requests[2].params.prompt[0].text.length, 50000);
});

test('real adapter receives cancellation before process termination', async () => {
 const fs = require('node:fs'), os = require('node:os');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-cancel-'));
 const marker = path.join(dir, 'cancelled'); const abort = new AbortController();
 const source = `const r=require('node:readline').createInterface({input:process.stdin});let id;const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');r.on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}});else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:${JSON.stringify(session)}}});else if(m.method==='session/prompt'){id=m.id;send({jsonrpc:'2.0',method:'session/update',params:{sessionId:${JSON.stringify(session)},update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ready'}}}});}else if(m.method==='session/cancel'){require('node:fs').writeFileSync(${JSON.stringify(marker)},'cancelled');send({jsonrpc:'2.0',id,result:{stopReason:'cancelled'}});}});`;
 const f = fixture(); f.options.cwd = dir;
 try {
  await assert.rejects(chat({ ...f.options, signal: abort.signal, spawnProcess(_, args, opts) {
   const child = require('node:child_process').spawn(process.execPath, ['-e', source], opts);
   child.stdout.on('data', bytes => { if(bytes.toString().includes('ready')) setImmediate(() => abort.abort()); });
   return child;
  } }));
  assert.equal(fs.readFileSync(marker,'utf8'),'cancelled');
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
