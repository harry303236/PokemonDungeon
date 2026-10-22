// Regression: jewel bar stays one scrollable row, no stale tooltips after re-render, T/Tab/I panels mutually exclusive.
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } }); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
await p.goto('http://127.0.0.1:4173/?debug'); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(2500); await p.keyboard.press('Enter'); await p.waitForTimeout(1000);
await p.evaluate(() => { const g = window.__pokedungeon; const s = g.sim(); s.gainXp(9e6); const b = s.build; for (const id of g.boardPath('util_jewel').slice(1)) b.allocNode(id); s.debugGrantJewels(); for (let i = 0; i < 40; i++) b.s.board.jewels.push(s.rollJewel('normal')); b.socketJewel('util_jewel', b.s.board.jewels[3].uid); s.refreshBuild(); });
await p.keyboard.press('t'); await p.waitForTimeout(800);
const vis = () => p.evaluate(() => !!document.querySelector('#tb-tipbox'));
const cards = await p.$$('[data-jw]'); await cards[2].hover(); await p.waitForTimeout(150); await cards[2].click(); await p.waitForTimeout(150);
console.log('tip after click (on card)', await vis());
await p.mouse.move(640, 20); await p.waitForTimeout(150); console.log('tip after moving to header (should be false)', await vis());
await p.mouse.move(900, 300); await p.waitForTimeout(150);
const bar = await p.evaluate(() => { const e = document.querySelector('#tb-jwbar'); const r = e.getBoundingClientRect(); return { h: r.height, top: r.top, sw: e.scrollWidth, cw: e.clientWidth }; }); console.log('bar', JSON.stringify(bar));
await p.mouse.move(700, 690); await p.mouse.wheel(0, 400); await p.waitForTimeout(200); console.log('scrolled', await p.evaluate(() => document.querySelector('#tb-jwbar').scrollLeft), 'zoom', await p.textContent('#tb-zoom'));
await p.mouse.move(900, 300); await p.waitForTimeout(150);
await p.screenshot({ path: '/workspace/pokedungeon-shots/32-jewel-bar-fixed.png' });
// asc stale hover
await p.click('#tb-asc'); await p.waitForTimeout(200); await p.hover('[data-asc=asc_flame_wing]'); await p.click('[data-asc=asc_flame_wing]'); await p.waitForTimeout(150); await p.mouse.move(640, 20); await p.waitForTimeout(150); console.log('asc tip stale?', await vis());
// panels exclusive
await p.keyboard.press('Tab'); await p.waitForTimeout(200); const st1 = await p.evaluate(() => document.querySelector('#talent-board-ui').style.display); await p.keyboard.press('t'); await p.waitForTimeout(400);
await p.keyboard.press('i'); await p.waitForTimeout(200); const st2 = await p.evaluate(() => document.querySelector('#talent-board-ui').style.display);
console.log('board after Tab', st1, 'board after I', st2);
await p.screenshot({ path: '/workspace/pokedungeon-shots/32-panels-exclusive.png' });
console.log(errs); await b.close();
