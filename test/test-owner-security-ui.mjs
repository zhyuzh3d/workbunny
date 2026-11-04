import test from 'node:test';
import assert from 'node:assert/strict';
import {mountOwnerSecurity} from '../src/renderer/owner-security.mjs';
test('identity settings start disabled and enable password entry only after the local switch save succeeds',async()=>{
 const nodes=Object.fromEntries(['ownerIdentityKey','ownerIdentityEnabled','ownerIdentitySave','ownerIdentityClear','ownerIdentityStatus'].map(id=>[id,{value:'',disabled:true,checked:false,listeners:{},addEventListener(name,fn){this.listeners[name]=fn;}}]));
 globalThis.document={getElementById:id=>nodes[id]};let state={enabled:false,configured:false},release;
 const pet={ownerSecurityStatus:async()=>state,ownerSecurityEnable:async enabled=>new Promise(r=>{release=()=>{state={...state,enabled};r(state);};}),ownerSecurityChange:async value=>state={...state,configured:!!value}};
 try{mountOwnerSecurity(pet);await new Promise(r=>setImmediate(r));assert(nodes.ownerIdentityKey.disabled);assert(nodes.ownerIdentitySave.disabled);assert(!nodes.ownerIdentityEnabled.disabled);
 nodes.ownerIdentityEnabled.checked=true;nodes.ownerIdentityEnabled.listeners.change();assert(nodes.ownerIdentityKey.disabled);assert(nodes.ownerIdentityEnabled.disabled);release();await new Promise(r=>setImmediate(r));assert(!nodes.ownerIdentityKey.disabled);assert(!nodes.ownerIdentitySave.disabled);
 nodes.ownerIdentityKey.value='Synthetic-only-key';nodes.ownerIdentitySave.listeners.click();await new Promise(r=>setImmediate(r));assert.equal(nodes.ownerIdentityKey.value,'');assert(state.configured);
 nodes.ownerIdentityEnabled.checked=false;nodes.ownerIdentityEnabled.listeners.change();release();await new Promise(r=>setImmediate(r));assert(nodes.ownerIdentityKey.disabled);assert(nodes.ownerIdentitySave.disabled);assert(!nodes.ownerIdentityEnabled.checked);
 }finally{delete globalThis.document;}
});
