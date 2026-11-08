import test from 'node:test';
import assert from 'node:assert/strict';
import {taskCard} from '../src/renderer/task-card.mjs';
class Element {
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.disabled=false;}
 get childElementCount(){return this.children.length;}
 set disabled(value){this._disabled=!!value;}
 get disabled(){return this._disabled;}
 append(...children){this.children.push(...children);}
 setAttribute(){}
 querySelector(){return null;}
}
const document={createElement:tag=>new Element(tag)};
function buttons(card){const result=new Map();const visit=n=>{if(n.tag==='button')result.set(n.dataset.operation,n);n.children.forEach(visit);};visit(card);return result;}
test('pending cards keep normal pause and stop controls available while disabling other actions',()=>{
 const calls=[],running=buttons(taskCard({id:'fixture',status:'running'},{document,pending:true,onAction:operation=>calls.push(operation)}));
 assert.equal(running.get('pause').disabled,false);assert.equal(running.get('stop').disabled,false);assert.equal(running.get('check').disabled,true);
 running.get('pause').onclick();running.get('stop').onclick();assert.deepEqual(calls,['pause','stop']);
 const paused=buttons(taskCard({id:'fixture',status:'paused'},{document,pending:true}));
 assert.equal(paused.get('resume').disabled,true);assert.equal(paused.get('stop').disabled,false);
 const attention=buttons(taskCard({id:'fixture',status:'needs_attention',presentation:{guidance:{kind:'work-submit',title:'fixture',detail:'fixture',primaryLabel:'继续'}}},{document,pending:true}));
 assert.equal(attention.get('resolve').disabled,true);assert.equal(attention.get('pause').disabled,false);assert.equal(attention.get('stop').disabled,false);
});
test('existing in-progress stop guidance still disables its duplicate stop button',()=>{
 const card=buttons(taskCard({id:'fixture',status:'needs_attention',presentation:{guidance:{kind:'stop',title:'fixture',detail:'fixture',primaryLabel:'停止',working:true}}},{document,pending:true}));
 assert.equal(card.get('stop').disabled,true);
});
