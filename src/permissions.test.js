const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { managerArgs, openManager } = require('./permissions');
test('workspace is an argument, not a command or authority', () => {
 assert.deepEqual(managerArgs('/installed/companion', '/project/$(touch nope)'), ['/installed/companion', ['--permissions-workspace','/project/$(touch nope)']]);
 for (const value of ['relative','/project\nother','/project\0other']) assert.throws(() => managerArgs('/installed/companion',value));
});
test('every open uses fresh workspace with no stored grants or token', async () => {
 const calls=[];
 const spawn=(program,args,options)=>{calls.push({program,args,options});const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',0));return child;};
 await openManager('/installed/companion','/first',spawn);
 await openManager('/installed/companion','/second',spawn);
 assert.equal(calls[1].args[1],'/second');assert.equal(calls[0].options.shell,false);
 assert.equal(calls[0].args.length,2);
});
test('failed native refresh remains unavailable', async () => {
 await assert.rejects(openManager('/installed/companion','/project',()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',1));return child;}),/Reopen/);
});
