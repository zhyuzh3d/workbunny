#!/usr/bin/env node
'use strict';

/* Run with node_modules/.bin/electron tools/test-bubble-ui.cjs.
 * This hidden, isolated fixture window does not open the WorkBuddy app.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const appJs = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(__dirname, '../src/renderer/style.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
const { app, BrowserWindow } = require('electron');
if (!app || !BrowserWindow || !process.versions.electron) throw new Error('请使用 Electron 运行 bubble UI fixture');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-bubble-fixture-'));
app.setPath('userData', path.join(temp, 'userData'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
const fixture = path.join(__dirname, 'fixtures', 'bubble-ui.html');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;

async function evaluate(script) { return win.webContents.executeJavaScript(script, true); }
async function waitFor(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(30); }
  throw new Error(`bubble fixture timeout: ${label}`);
}

async function testViewportAndScaleBounds() {
  for (const [width, height, zoom] of [[190, 140, 0.75], [320, 240, 1], [560, 760, 1.25]]) {
    win.setContentSize(width, height);
    win.webContents.setZoomFactor(zoom);
    await delay(120);
    await evaluate(`window.fixture.controller.show(${JSON.stringify('长回答'.repeat(180) + ' English words '.repeat(100))}, 60000); window.fixture.controller.place(3, innerHeight)`);
    const metrics = await evaluate(`(() => {
      const b=document.getElementById('bubble'), s=getComputedStyle(b), r=b.getBoundingClientRect();
      return {innerWidth,innerHeight,top:r.top,bottom:r.bottom,height:r.height,clientHeight:b.clientHeight,scrollHeight:b.scrollHeight,
        maxHeight:s.maxHeight,overflowY:s.overflowY,scrollbarWidth:s.scrollbarWidth,tabIndex:b.tabIndex,
        paddingTop:parseFloat(s.paddingTop),paddingBottom:parseFloat(s.paddingBottom),lineHeight:parseFloat(s.lineHeight)};
    })()`);
    assert.ok(metrics.top >= 7.5, `top stays visible at ${width}x${height}@${zoom}: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.bottom <= metrics.innerHeight - 7.5, `bottom stays visible at ${width}x${height}@${zoom}`);
    assert.ok(metrics.height <= metrics.innerHeight - 15, `bubble fits viewport at ${width}x${height}@${zoom}`);
    assert.equal(metrics.overflowY, 'auto');
    assert.equal(metrics.scrollbarWidth, 'none');
    assert.equal(metrics.tabIndex, 0, 'bubble can receive keyboard scrolling');
    assert.ok(metrics.scrollHeight > metrics.clientHeight, 'long Chinese and English content remains scrollable');
    const contentRows = (metrics.clientHeight - metrics.paddingTop - metrics.paddingBottom) / metrics.lineHeight;
    assert.ok(contentRows <= 5.1, `visible text region is capped at five lines: ${contentRows}`);
    const dock = await evaluate("(() => {const e=document.getElementById('dock'),s=getComputedStyle(e);return {position:s.position,bottom:s.bottom}})()");
    assert.equal(dock.position, 'fixed', 'bottom anchored input position remains fixed');
    assert.ok(dock.bottom !== 'auto', 'bottom anchored input remains on its existing CSS anchor');
  }
  assert.match(appJs, /#ear, #dock, #bubble/u, 'bubble remains part of the interactive hit-test so scroll events reach it');
  assert.match(appJs, /pet\.hit\(inside\)/u, 'leaving the bubble returns the window to click-through behavior');
  assert.match(appJs, /stage\.addEventListener\('mousedown'/u, 'only character-stage presses initiate drag/click handling');
  assert.equal(await evaluate("document.getElementById('stage').contains(document.getElementById('bubble'))"), false,
    'bubble scroll input is outside the character click/drag surface');
  assert.match(indexHtml, /id="bubble"[^>]*tabindex="0"/u, 'production bubble can receive keyboard scrolling');
  assert.match(styleCss, /#bubble::?-webkit-scrollbar\s*\{\s*display:\s*none/su);
}

async function testShortTextCompactAndNewTurnResetsScroll() {
  await evaluate(`window.fixture.controller.show('短句。',60000); window.fixture.controller.place(360,innerHeight)`);
  const shortHeight = await evaluate("document.getElementById('bubble').getBoundingClientRect().height");
  assert.ok(shortHeight < 90, `short text remains compact: ${shortHeight}`);

  await evaluate(`window.fixture.controller.hide(); window.fixture.controller.appendDelta(${JSON.stringify('滚动测试'.repeat(180))}); window.fixture.controller.place(360,innerHeight)`);
  const max = await evaluate("document.getElementById('bubble').scrollHeight-document.getElementById('bubble').clientHeight");
  await evaluate(`document.getElementById('bubble').scrollTop=${Math.max(0, max - 12)}`);
  await evaluate(`window.fixture.controller.appendDelta(${JSON.stringify('追加的一段内容'.repeat(30))})`);
  const preserved = await evaluate("document.getElementById('bubble').scrollTop");
  assert.ok(preserved > 0, 'streaming updates preserve a user scroll position');
  await evaluate(`window.fixture.controller.finish(${JSON.stringify('滚动测试'.repeat(180) + '追加的一段内容'.repeat(30))},60000)`);
  assert.equal(await evaluate("document.getElementById('bubble').scrollTop"), preserved, 'final chat event does not jump the scroll');

  await evaluate(`window.fixture.controller.show(${JSON.stringify('下一轮'.repeat(160))},60000)`);
  assert.equal(await evaluate("document.getElementById('bubble').scrollTop"), 0, 'new message resets to the beginning');
}

async function testMouseAndKeyboardScrollInput() {
  win.webContents.setZoomFactor(1);
  win.setContentSize(560, 760);
  await delay(100);
  await evaluate(`window.fixture.controller.show(${JSON.stringify('滚动方向测试。'.repeat(220))},60000); window.fixture.controller.place(innerHeight/2,innerHeight); document.getElementById('bubble').scrollTop=0; document.getElementById('bubble').focus()`);
  await evaluate("document.getElementById('bubble').dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true}))");
  const afterWheel = await evaluate("document.getElementById('bubble').scrollTop");
  assert.ok(afterWheel > 0, 'mouse wheel handler scrolls the bubble content');
  await evaluate("document.getElementById('bubble').dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true,cancelable:true}))");
  const afterReverseWheel = await evaluate("document.getElementById('bubble').scrollTop");
  assert.ok(afterReverseWheel < afterWheel, 'wheel can scroll back toward the beginning');
  await evaluate("document.getElementById('bubble').dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true,cancelable:true}))");
  const afterKey = await evaluate("document.getElementById('bubble').scrollTop");
  assert.ok(afterKey > afterReverseWheel, 'keyboard PageDown scrolls while bubble is focused');
}

async function testHoverAndFocusPauseAndResumeHideTimer() {
  await evaluate("window.fixture.controller.show('阅读这段较长回复',4200)");
  assert.deepEqual(await evaluate('window.fixture.clock.pending()'), [4200]);
  await evaluate("document.getElementById('bubble').dispatchEvent(new MouseEvent('mouseenter'))");
  assert.deepEqual(await evaluate('window.fixture.clock.pending()'), [], 'hover pauses the timer');
  await evaluate("document.getElementById('bubble').dispatchEvent(new MouseEvent('mouseleave'))");
  assert.deepEqual(await evaluate('window.fixture.clock.pending()'), [4200], 'leaving restarts the original duration');

  await evaluate("document.getElementById('bubble').dispatchEvent(new FocusEvent('focusin',{bubbles:true}))");
  assert.deepEqual(await evaluate('window.fixture.clock.pending()'), [], 'keyboard focus pauses the timer');
  await evaluate("document.getElementById('bubble').dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:document.getElementById('memoryBasis')}))");
  assert.deepEqual(await evaluate('window.fixture.clock.pending()'), [], 'focus moving to an inner button remains protected');
  await evaluate("document.getElementById('bubble').dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:document.body}))");
  assert.deepEqual(await evaluate('window.fixture.clock.pending()'), [4200], 'leaving the bubble focus restarts the timer');

  await evaluate("document.getElementById('bubble').dispatchEvent(new MouseEvent('mouseenter'))");
  await evaluate("document.getElementById('bubble').dispatchEvent(new FocusEvent('focusin',{bubbles:true}))");
  await evaluate("document.getElementById('bubble').dispatchEvent(new MouseEvent('mouseleave'))");
  assert.deepEqual(await evaluate('window.fixture.clock.pending()'), [], 'one remaining interaction still pauses hiding');
  await evaluate("document.getElementById('bubble').dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:document.body}))");
  assert.deepEqual(await evaluate('window.fixture.clock.pending()'), [4200]);
  assert.equal(await evaluate('window.fixture.clock.fire()'), true);
  assert.equal(await evaluate("document.getElementById('bubble').classList.contains('hidden')"), true,
    'the bubble still hides after the restarted timer expires');
}

async function testWebSourcesStayLocalAndOpenOnlyValidatedTitles() {
  const sourcePainter = appJs.match(/function clearWebSources\(\) \{[\s\S]*?(?=\nfunction hideBubble\(\))/u)?.[0];
  assert(sourcePainter, 'the production source painter can be isolated from the WebGL controller');
  assert.match(appJs, /case 'webSources':\s*paintWebSources\(ev\)/u, 'the backend reference event is consumed');
  assert.match(appJs, /case 'chat':[\s\S]{0,100}clearWebSources\(\)/u, 'a new user turn clears prior references');
  assert.match(appJs, /case 'delta':[\s\S]{0,80}clearWebSources\(\)/u, 'a new streamed reply clears prior references');
  assert.match(sourcePainter, /button\.textContent = source\.title/u);
  assert.match(sourcePainter, /pet\.openWebSource\(source\.url\)/u);
  assert.doesNotMatch(sourcePainter, /innerHTML|textContent\s*=\s*source\.url/u, 'URLs are neither rendered nor injected as markup');
  await evaluate(`window.fixture.installSourcePainter(${JSON.stringify(sourcePainter)})`);
  await evaluate(`window.fixture.paintSources({used:false,sources:[{title:'隐藏来源',url:'https://example.com'}]})`);
  assert.equal(await evaluate("document.getElementById('webSources').classList.contains('hidden')"), true,
    'unused search results stay hidden');

  const sources = [
    { title: '标题很长'.repeat(20), url: 'https://example.com/one' },
    { title: '第二条参考', url: 'https://example.org/two' },
    { title: '不安全协议', url: 'javascript:alert(1)' },
    { title: '第三条参考', url: 'http://example.net/three' },
    { title: '超出展示上限', url: 'https://example.edu/four' },
  ];
  await evaluate(`window.fixture.controller.show(${JSON.stringify('回答内容'.repeat(36))},60000); window.fixture.controller.place(innerHeight/2,innerHeight); window.fixture.paintSources(${JSON.stringify({ used: true, sources })})`);
  const rendered = await evaluate(`(() => {
    const b=document.getElementById('bubble'), c=document.getElementById('webSources'), links=[...document.querySelectorAll('.web-source-link')];
    const rect=c.getBoundingClientRect(), br=b.getBoundingClientRect(), style=getComputedStyle(links[0]);
    return {hidden:c.classList.contains('hidden'),titles:links.map(x=>x.textContent),labels:links.map(x=>x.getAttribute('aria-label')),
      count:links.length,withinBubble:rect.left>=br.left && rect.right<=br.right,scroll:b.scrollHeight>b.clientHeight,
      maxHeight:parseFloat(getComputedStyle(b).maxHeight),innerHeight,hoverColor:getComputedStyle(links[0],':hover').color,baseColor:style.color};
  })()`);
  assert.equal(rendered.hidden, false);
  assert.equal(rendered.count, 3, 'only three valid unique references are displayed');
  assert.deepEqual(rendered.titles.slice(1), ['第二条参考', '第三条参考']);
  assert.match(rendered.labels[0], /打开参考来源/u);
  assert.equal(rendered.withinBubble, true, 'reference row stays within the compact bubble width');
  assert.equal(rendered.scroll, true, 'long content and references use the existing bounded scroll region');
  assert.notEqual(rendered.hoverColor, rendered.baseColor, 'hover gives a visible text contrast change');
  assert.ok(rendered.maxHeight <= rendered.innerHeight - 16, 'source layout remains bounded by available window height');
  await evaluate("document.querySelector('.web-source-link').click()");
  assert.deepEqual(await evaluate('window.fixture.openedSources'), ['https://example.com/one'],
    'click delegates the validated HTTP URL to the preload opener');

  await evaluate('window.fixture.clearSources()');
  assert.equal(await evaluate("document.getElementById('webSources').classList.contains('hidden')"), true,
    'clearing a turn removes the old reference row');
  assert.equal(await evaluate("document.getElementById('bubble').classList.contains('has-web-sources')"), false);
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 560, height: 760, show: false, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: true } });
  await win.loadFile(fixture);
  await waitFor(() => evaluate('!!window.fixture?.controller'), 'module init');
  // DOM input events exercise production handlers in an isolated hidden window.
  await testViewportAndScaleBounds();
  await testShortTextCompactAndNewTurnResetsScroll();
  await testMouseAndKeyboardScrollInput();
  await testHoverAndFocusPauseAndResumeHideTimer();
  await testWebSourcesStayLocalAndOpenOnlyValidatedTitles();
  console.log('bubble UI fixture: viewport bounds, five-line cap, references, source validation, stream preservation, mouse/keyboard scrolling, and hide timer interaction passed');
  win.destroy();
  fs.rmSync(temp, { recursive: true, force: true });
  app.quit();
}).catch(error => {
  console.error(error.stack || error);
  if (win && !win.isDestroyed()) win.destroy();
  fs.rmSync(temp, { recursive: true, force: true });
  app.exit(1);
});
