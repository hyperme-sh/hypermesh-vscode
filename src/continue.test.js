const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { args, exchange, label, tracking } = require('./continue');
function fixture(response, { code = 0, inspect = () => {} } = {}) {
 return (program, argv, options) => {
  const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin.end = input => { inspect({ program, argv, options, input }); queueMicrotask(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(response))); child.emit('exit', code); }); };
  return child;
 };
}
const run = { id:'11111111-1111-4111-8111-111111111111',workspace:'/project',revision:7,state:'paused',continue_enabled:false,used_chunks:1,budgets:{chunks:2} };
test('workspace selection is an argument and cannot become a shell command', () => {
 assert.deepEqual(args('/installed/companion','/project/$(ignored)','status'), ['/installed/companion',['--continue-status-workspace','/project/$(ignored)']]);
 assert.throws(() => args('/installed/companion','relative','status'));
 assert.throws(() => args('/installed/companion','/project','shell'));
});
test('reconnect reads existing paused state without starting a task', async () => {
 const result = await exchange('/installed/companion','/project',null,fixture({run},{inspect(call){assert.equal(call.input,'');assert.equal(call.options.shell,false);assert.equal(call.argv[0],'--continue-status-workspace');}}));
 assert.equal(result.run.state,'paused');assert.match(label(result.run),/Continue off/);
});
test('controls retain the observed revision and require owner acknowledgement', async () => {
 const control = {run_id:run.id,revision:7,action:'continue-on'};
 const result = await exchange('/installed/companion','/project',control,fixture({run:{...run,revision:8,continue_enabled:true}},{inspect(call){assert.deepEqual(JSON.parse(call.input),control);assert.equal(call.argv[0],'--continue-control-workspace');}}));
 assert.equal(result.run.revision,8);
 await assert.rejects(exchange('/installed/companion','/project',control,fixture({}, {code:1})),/Refresh/);
});
test('wrong workspace, missing state and oversized responses are refused', async () => {
 for (const value of [{run:{...run,workspace:'/other'}},{}, {run:{...run,detail:'x'.repeat(40000)}}]) await assert.rejects(exchange('/installed/companion','/project',null,fixture(value)));
});
test('tracking links are bounded central issue PR and check URLs only', () => {
 assert.deepEqual(tracking({tracking:['https://github.com/hyperme-sh/visor/issues/265','https://github.com/hyperme-sh/visor/pull/313','https://evil.test/steal','https://github.com/a/b/issues/1?token=secret']}),['https://github.com/hyperme-sh/visor/issues/265','https://github.com/hyperme-sh/visor/pull/313']);
 assert.match(label({...run,state:'completed'}),/completed/);
 assert.match(label({...run,state:'external-blocker'}),/external-blocker/);
});
