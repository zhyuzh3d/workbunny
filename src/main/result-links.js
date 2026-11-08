'use strict';
const { createHash } = require('node:crypto');
const MAX_LINKS = 32;
function validResultURL(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\s\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return /^https?:\/\//iu.test(value) && ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
function sourceLink(value) {
  const url = typeof value === 'string' ? value : value?.url;
  if (!validResultURL(url)) return null;
  const label = typeof value?.label === 'string' ? value.label.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 160) : '';
  // Keep source bytes, especially query parameters, escapes and fragments.
  return { id: 'url-' + createHash('sha256').update(url).digest('hex').slice(0, 24), url, ...(label ? { label } : {}) };
}
function trimClosingDelimiters(value) {
    let url = value.replace(/[。，；、！]+$/u, '');
    // A Markdown/parenthetical closing delimiter is not part of the URL unless
    // it balances an opening delimiter within that URL.
    const counts = Object.fromEntries(['(', ')', '[', ']', '{', '}'].map(c => [c, 0]));
    for (const c of url) if (Object.hasOwn(counts,c)) counts[c]++;
    for (;;) {
      const close = url.at(-1), open = { ')': '(', ']': '[', '}': '{' }[close];
      if (!open || counts[close] <= counts[open]) break;
      counts[close]--; url = url.slice(0, -1);
    }
    return url;
}
function scanResultLinks(text) {
  if (typeof text !== 'string') return [];
  const escaped=at=>{let count=0;while(at>0&&text[--at]==='\\')count++;return count%2===1;};
  const tick=String.fromCharCode(96),code=[...text.matchAll(new RegExp('('+tick+'+)([\\s\\S]*?)\\1','gu'))].map(m=>[m.index,m.index+m[0].length]);
  const inCode=at=>code.some(([start,end])=>start<=at&&at<end);
  const links=[];
  for(const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/giu)){
    const start=match.index,legacyRaw=trimClosingDelimiters(match[0]);let end=start+match[0].length;
    // A Markdown destination is literal URL data: stars inside it are not
    // emphasis. Its unmatched closing parenthesis ends the destination.
    if(/\[[^\]\r\n]*\]\($/u.test(text.slice(0,start))){
      let depth=0;
      for(let i=start;i<end;i++){
        if(text[i]==='(')depth++;
        else if(text[i]===')'){if(!depth){end=i;break;}depth--;}
      }
    }else if(!inCode(start)){
      const line=text.lastIndexOf('\n',start-1)+1,open=new Set();
      for(const marker of text.slice(line,start).matchAll(/\*{1,3}|_{1,3}|~~/gu)){
        const at=line+marker.index,value=marker[0],before=text[at-1]||'',after=text[at+value.length]||'';
        if(escaped(at)||inCode(at)||value[0]==='_'&&/[\p{L}\p{N}]/u.test(before)&&/[\p{L}\p{N}]/u.test(after))continue;
        if(open.has(value)&&before&&!/\s/u.test(before))open.delete(value);
        else if(after&&!/\s/u.test(after))open.add(value);
      }
      // Match only a closing presentation delimiter at the token boundary.
      // Interior stars/underscores are URL bytes, not formatting to rewrite.
      const tail=match[0].match(/[.,!?;:)\]}。，；、！]*$/u)?.[0]||'',boundary=end-tail.length;
      for(const marker of [...open].sort((a,b)=>b.length-a.length))if(text.slice(start,boundary).endsWith(marker)&&!escaped(boundary-marker.length)){end=boundary-marker.length;break;}
    }
    const entry=sourceLink(trimClosingDelimiters(text.slice(start,end)));
    if(entry)links.push({entry,legacyRaw});
    if(links.length>=MAX_LINKS)break;
  }
  return links;
}
function extractResultLinks(text) {
  return resultLinkCandidates(scanResultLinks(text).map(item=>item.entry));
}
function resultLinkCandidates(...sources) {
  const links = [], seen = new Set(),corrections=new Map();
  for(const source of sources)if(typeof source==='string')for(const {entry,legacyRaw}of scanResultLinks(source))if(legacyRaw!==entry.url)corrections.set(legacyRaw,entry.url);
  for (const source of sources) for (const value of typeof source === 'string' ? scanResultLinks(source).map(item=>item.entry) : Array.isArray(source) ? source : []) {
    const raw=typeof value==='string'?value:value?.url,corrected=corrections.get(raw);
    const entry = sourceLink(corrected?{...(typeof value==='object'?value:{}),url:corrected}:value);
    if (!entry || seen.has(entry.url)) continue;
    seen.add(entry.url); links.push(entry);
    if (links.length >= MAX_LINKS) return links;
  }
  return links;
}
function normalizeResultLinks(values) {
  return resultLinkCandidates(values).map(({ id, ...link }) => link);
}
function selectResultLinks(candidates, linkIds) {
  const source = new Map(resultLinkCandidates(candidates).map(link => [link.id, link]));
  if (!Array.isArray(linkIds) || linkIds.length > MAX_LINKS || linkIds.some(id => typeof id !== 'string' || !source.has(id))) {
    throw Object.assign(new Error('成果入口必须选择实际答复中的链接编号'), { code: 'E_RESULT_LINKS' });
  }
  return normalizeResultLinks([...new Set(linkIds)].map(id => source.get(id)));
}
function resultLinks(result) {
  if (!result || typeof result !== 'object') return [];
  return Object.hasOwn(result, 'links') ? normalizeResultLinks(result.links) : normalizeResultLinks(extractResultLinks(result.text));
}
module.exports = { validResultURL, extractResultLinks, resultLinkCandidates, normalizeResultLinks, selectResultLinks, resultLinks };
