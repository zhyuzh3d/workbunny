'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{keyboardVisible}=require('./phone-visual.cjs');
test('an already visible keyboard requires no risky second composer tap',()=>{
 const keys='qwertyuiop'.split('').map((text,i)=>({text,x:.05+i*.09,y:.74}));
 assert(keyboardVisible([...keys,{text:'123',x:.8,y:.95}]));
 assert(!keyboardVisible(keys));
 assert(!keyboardVisible([{text:'q',x:.1,y:.74},{text:'123',x:.8,y:.95}].flatMap(r=>Array(12).fill(r))));
 assert(!keyboardVisible([{text:'Owner UX test',x:.3,y:.8},{text:'123',x:.8,y:.5}]));
});
