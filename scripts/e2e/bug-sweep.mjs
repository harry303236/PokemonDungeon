// Browser bug sweep (needs `npx vite preview --port 4173` + Chrome). Usage: node scripts/e2e/bug-sweep.mjs [debug]
import { chromium } from 'playwright-core';
const DEBUG = process.argv[2] === 'debug'; const URL = 'http://127.0.0.1:4173/' + (DEBUG ? '?debug' : '');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } }); const errs = [];
p.on('pageerror', e => errs.push('PAGEERR ' + e.message)); p.on('console', m => { if (m.type()==='error' || m.type()==='warning') errs.push(m.type() + ' ' + m.text()); });
p.on('response', r => { if (r.status() >= 400) errs.push('HTTP ' + r.status() + ' ' + r.url()); });
const log = (...a) => console.log(...a);
const S = (f, a) => p.evaluate(f, a);
const boardOpen = () => p.evaluate(() => document.querySelector('#talent-board-ui')?.style.display === 'block');
const setBoard = async (v) => { if ((await boardOpen()) !== v) { await p.keyboard.press('t'); await p.waitForTimeout(800); } };
const badText = async (tag) => { const t = await S(() => document.body.innerText); const m = t.match(/.{0,30}(NaN|undefined|\[object|null%|Infinity).{0,30}/g); if (m) log('BADTEXT', tag, m.slice(0, 5));
  const imgs = await S(() => [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src'))); if (imgs.length) log('BROKENIMG', tag, [...new Set(imgs)]); };
await p.goto(URL); await S(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(2500);
await p.keyboard.press('Enter'); await p.waitForTimeout(1200);
const G = () => S(() => { const s = window.__pokedungeon.sim(); return { lvl: s.progress.level, floor: s.floorNo, hp: s.player.hp, max: s.player.maxHp, pts: s.build.pointsLeft(), dead: s.player.dead, nodes: s.build.s.board.nodes.length, moves: JSON.stringify(s.build.s.board.moves) }; });
log('start', JSON.stringify(await G()));
// L key (debug-only?)
await p.keyboard.press('l'); await p.waitForTimeout(200); log('after L', JSON.stringify(await G()));
// fight: hold right click on nearest enemy region by moving around & slots
for (let i = 0; i < 4; i++) { for (const k of ['q','w','e','r']) { await p.keyboard.press(k); await p.waitForTimeout(150); } await p.mouse.click(640 + (i%2?200:-200), 360, { button: 'right' }); await p.waitForTimeout(300); }
log('fight', JSON.stringify(await G())); await badText('fight');
// gain levels by xp (simulating kills)
await S(() => { const s = window.__pokedungeon.sim(); s.gainXp(5000); s.refreshBuild(); });
log('xp', JSON.stringify(await G()));
// open board with T
await p.keyboard.press('t'); await p.waitForTimeout(800); await badText('board');
const pos = (id) => S((id) => { const g = window.__pokedungeon; const sc = g.game.scene.getScene('talent-board'); const w = g.boardPos(id); const c = g.game.canvas.getBoundingClientRect(); const s = sc.worldToScreen(w.x, w.y); return { x: s.x + c.left, y: s.y + c.top }; }, id);
const tip = async () => (await p.textContent('#tb-tip').catch(() => '')).replace(/\s+/g, ' ');
// click path via real mouse clicks
const path = await S(() => window.__pokedungeon.boardPath('sun_N1'));
for (const id of path.slice(1)) { await S((id) => { const g = window.__pokedungeon; const sc = g.game.scene.getScene('talent-board'); const w = g.boardPos(id); sc.centerOn(w.x, w.y); }, id); await p.waitForTimeout(80); const q = await pos(id); await p.mouse.click(q.x, q.y); await p.waitForTimeout(80); }
log('planned tip', await tip()); await badText('plan');
// trunk tab, + on flame_charge
await p.click('#tb-tab-trunk'); await p.waitForTimeout(150); await p.click('[data-mv="flame_charge|1"]'); await p.click('[data-mv="ember|1"]'); await p.click('[data-mv="ember|1"]'); await badText('trunk');
log('planbar', (await p.textContent('#tb-plan').catch(() => 'NOPLAN')).replace(/\s+/g, ' '));
await p.click('#tb-ok'); await p.waitForTimeout(200); log('confirmed', JSON.stringify(await G()));
// variant buttons for ember at rank 3
const vb = await p.$$('[data-var]'); log('variant buttons', vb.length); if (vb.length) { await vb[0].click(); await p.waitForTimeout(100); }
await p.click('#tb-tab-board');
// respec: right-click the last node
const last = path.at(-1); const q = await pos(last); await p.mouse.click(q.x, q.y, { button: 'right' }); await p.waitForTimeout(100); log('remove tip?', await tip());
await p.click('#tb-ok').catch(() => log('no ok')); await p.waitForTimeout(200); log('after respec', JSON.stringify(await G()));
// key conflicts while board open
for (const k of ['Tab','i','q','1','k','j']) { await p.keyboard.press(k); await p.waitForTimeout(150); }
log('open panels after keys', JSON.stringify(await S(() => ({ board: !!document.querySelector('#talent-board-ui')?.offsetParent || document.querySelector('#talent-board-ui')?.style.display, skillsVisible: [...document.querySelectorAll('div')].filter(d => d.style.zIndex && getComputedStyle(d).display !== 'none' && d.offsetWidth > 300).map(d => d.id || d.className || d.style.zIndex) }))));
await p.keyboard.press('Tab'); await p.keyboard.press('i'); await p.keyboard.press('i'); await p.waitForTimeout(150);
await p.screenshot({ path: '/tmp/sw-keys-' + (DEBUG ? 'd' : 'n') + '.png' });
await p.keyboard.press('Tab'); await p.waitForTimeout(100); await setBoard(false); log('panels closed?', await S(() => [...document.querySelectorAll('div')].filter(d => d.style.zIndex && getComputedStyle(d).display !== 'none' && d.offsetWidth > 300).length));
// jewels via drops
await S(() => { const s = window.__pokedungeon.sim(); for (let i = 0; i < 400; i++) s.maybeDropJewel?.(Math.random() < 0.1); s.refreshBuild(); });
log('jewels', await S(() => window.__pokedungeon.sim().build.s.board.jewels.map(j => j.base).join(',')));
// evolve to charizard
await S(() => { const s = window.__pokedungeon.sim(); s.gainXp(9e7); s.refreshBuild(); }); log('lvl50', JSON.stringify(await G())); await p.waitForTimeout(300); await badText('evolved');
await setBoard(true);
await p.click('#tb-asc'); await p.waitForTimeout(300); await badText('asc');
await p.click('[data-asc="asc_flame_wing"]'); await p.click('[data-asc="asc_fw_1"]'); await p.click('[data-asc="asc_dragon_blood"]'); await p.waitForTimeout(100);
log('asc', await S(() => window.__pokedungeon.sim().build.s.board.asc.join(',')), (await p.textContent('#tb-ascp')).slice(0, 80).replace(/\s+/g, ' '));
await p.click('#tb-ascx');
// allocate path to jewel sockets and socket via UI
await S(() => { const g = window.__pokedungeon; const b = g.sim().build; for (const t of ['wing_jewel', 'util_jewel']) for (const id of g.boardPath(t).slice(1)) if (!b.s.board.nodes.includes(id)) b.allocNode(id); g.sim().refreshBuild(); g.game.scene.getScene('talent-board').ctrl.render(); });
const js = await p.$$('[data-jw]'); log('jewel cards', js.length);
if (js.length) { await js[0].click(); await S(() => { const g = window.__pokedungeon; const sc = g.game.scene.getScene('talent-board'); const w = g.boardPos('util_jewel'); sc.centerOn(w.x, w.y); }); await p.waitForTimeout(100);
  const u = await pos('util_jewel'); await p.mouse.move(u.x, u.y); await p.waitForTimeout(200); log('socket tip', await tip()); await p.mouse.click(u.x, u.y); await p.waitForTimeout(200);
  log('sockets', await S(() => JSON.stringify(window.__pokedungeon.sim().build.s.board.sockets)));
  await p.mouse.click(u.x, u.y, { button: 'right' }); await p.waitForTimeout(100); log('after unsocket', await S(() => JSON.stringify(window.__pokedungeon.sim().build.s.board.sockets)));
  await p.mouse.click(u.x, u.y, { button: 'right' }); await p.waitForTimeout(100); log('right-click socket again (plan remove?)', (await p.textContent('#tb-plan').catch(() => 'NOPLAN')).replace(/\s+/g, ' ')); await p.click('#tb-cancel').catch(() => {}); }
await badText('jewel');
// full reset
await p.click('#tb-reset'); await p.waitForTimeout(200); log('after reset', JSON.stringify(await G())); await badText('reset');
await setBoard(false);
// fight with each move & variant
const moves = await S(() => { const s = window.__pokedungeon.sim(); const b = s.build; for (const m of Object.keys(b.s.board.moves)) {} for (const m of ['ember','flame_charge','flamethrower','fire_spin','fire_blast']) { while ((b.s.board.moves[m] ?? 0) < 3 && b.rankMove(m).ok); } s.refreshBuild(); return JSON.stringify(b.s.board.moves) + ' pts ' + b.pointsLeft(); });
log('moves', moves);
const varRes = await S(() => window.__pokedungeon.sim().slots);
log('slots', JSON.stringify(varRes));
for (let i = 0; i < 6; i++) { for (const k of ['q','w','e','r']) { await p.keyboard.down(k); await p.waitForTimeout(120); await p.keyboard.up(k); } await p.mouse.click(400 + i * 80, 300, { button: 'right' }); await p.waitForTimeout(250); }
log('after casts', JSON.stringify(await G())); await badText('casts');
// floors
await S(() => { const s = window.__pokedungeon.sim(); s.loadFloor(s.floorNo + 1); }); await p.waitForTimeout(500); log('floor', JSON.stringify(await G()));
// save & reload
await p.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
const before = await S(() => JSON.stringify(window.__pokedungeon.sim().build.s.board));
await S(() => { const s = window.__pokedungeon.sim(); s.bus.emit('player:levelup', { level: s.progress.level }); });
await p.reload(); await p.waitForTimeout(2500); await p.keyboard.press('c'); await p.waitForTimeout(1200);
const after = await S(() => JSON.stringify(window.__pokedungeon.sim().build.s.board));
log('reload board same?', before === after, after.slice(0, 160)); log('after reload', JSON.stringify(await G()));
log('ERRS', errs.slice(0, 30)); await b.close();
