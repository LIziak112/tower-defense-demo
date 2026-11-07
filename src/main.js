// Presentation adapter: DOM/canvas/audio live here. Rules run in runtime.js.
const TICK_MS = 1000 / 30;
const byId = id => document.getElementById(id);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* Historical inline runtime retained temporarily for migration reference.
   The active game always uses runtime.js; remove this block after the next UI pass.
const UNIT_DEFS = {
  blade: { glyph: '刀', name: '刀兵', damage: 25, range: 2900, interval: 23, color: '#71362e' },
  spear: { glyph: '枪', name: '枪兵', damage: 34, range: 3700, interval: 27, color: '#3c5d49' },
  bow: { glyph: '弓', name: '弓兵', damage: 18, range: 7000, interval: 15, color: '#6a4b28' },
  horse: { glyph: '骑', name: '骑兵', damage: 44, range: 4700, interval: 32, color: '#424f65' },
  zhaoyun: { glyph: '赵云', name: '赵云', damage: 58, range: 7200, interval: 16, color: '#9a741e', hero: true },
  zhangfei: { glyph: '张飞', name: '张飞', damage: 90, range: 3600, interval: 36, color: '#88401f', hero: true },
  huangzhong: { glyph: '黄忠', name: '黄忠', damage: 52, range: 8000, interval: 19, color: '#80671c', hero: true }
};
const LETTERS = {
  char_zhao: '赵', char_yun: '云', char_zhang: '张', char_fei: '飞', char_huang: '黄', char_zhong: '忠'
};
const HERO_PAIRS = {
  'char_zhao+char_yun': 'zhaoyun', 'char_yun+char_zhao': 'zhaoyun',
  'char_zhang+char_fei': 'zhangfei', 'char_fei+char_zhang': 'zhangfei',
  'char_huang+char_zhong': 'huangzhong', 'char_zhong+char_huang': 'huangzhong'
};

function makePack(text = '') {
  const wet = /雨|沼泽|湿地/.test(text), fierce = /猛烈|人多|刺激|难/.test(text);
  return {
    meta: {
      theme: wet ? '长坂雨阵' : '古道墨阵', generated_from: text,
      description: fierce ? '敌军数量偏多但推进较慢，适合通过合成建立持续火力。' : '前军试探、后军压境，留出拼字成将的发育时间。'
    },
    palette: { ground: wet ? '#b9b59e' : '#cfc09e', path: wet ? '#6d756c' : '#8b7554', ink: '#24251f' },
    towers: Object.entries(UNIT_DEFS).map(([id, u]) => ({
      id, display_name: u.name,
      components: { Attack: { damage: u.damage, range_milli: u.range, interval_ticks: u.interval }, Buildable: { cost: 0 } }
    })),
    enemies: [
      { id: 'soldier', display_name: '魏卒', glyph: '卒', components: { Health: { max: fierce ? 82 : 68 }, Movement: { speed_milli_per_tick: fierce ? 38 : 45 }, PathFollower: { base_damage: 1 }, Reward: { gold: 6 } } },
      { id: 'captain', display_name: '魏将', glyph: '将', components: { Health: { max: 260 }, Movement: { speed_milli_per_tick: 26 }, PathFollower: { base_damage: 1 }, Reward: { gold: 18 } } }
    ],
    map: {
      grid: { width: 12, height: 6 }, path: [[0, 2], [11, 2]],
      buildable_cells: [[1,3],[4,3],[7,3],[10,3],[1,4],[4,4],[7,4],[10,4],[1,5],[4,5],[7,5],[10,5]],
      base: { max_health: 6 }, starting_gold: 100
    },
    waves: [
      { id: 'wave_1', groups: [{ enemy_id: 'soldier', count: 9, interval_ticks: 23 }] },
      { id: 'wave_2', groups: [{ enemy_id: 'soldier', count: 12, interval_ticks: 19 }, { enemy_id: 'captain', count: 1, interval_ticks: 48 }] },
      { id: 'wave_3', groups: [{ enemy_id: 'soldier', count: 15, interval_ticks: 16 }, { enemy_id: 'captain', count: 3, interval_ticks: 39 }] }
    ]
  };
}

function validatePack(p) {
  const errors = [], range = (v, a, b, path) => { if (!Number.isFinite(v) || v < a || v > b) errors.push({ code: 'VALUE_OUT_OF_RANGE', path, actual: v, allowed: { min: a, max: b } }); };
  if (!p?.map || !Array.isArray(p.towers) || !Array.isArray(p.enemies) || !Array.isArray(p.waves)) return { ok: false, errors: [{ code: 'SCHEMA', path: '/', message: '内容包缺少必要字段' }] };
  p.towers.forEach((t, i) => { const a = t.components.Attack; range(a.damage, 1, 100, `/towers/${i}/components/Attack/damage`); range(a.range_milli, 1000, 8000, `/towers/${i}/components/Attack/range_milli`); range(a.interval_ticks, 5, 120, `/towers/${i}/components/Attack/interval_ticks`); });
  p.enemies.forEach((e, i) => { range(e.components.Health.max, 10, 2000, `/enemies/${i}/components/Health/max`); range(e.components.Movement.speed_milli_per_tick, 10, 150, `/enemies/${i}/components/Movement/speed_milli_per_tick`); });
  if (p.waves.length < 3 || p.waves.length > 10) errors.push({ code: 'WAVE_COUNT', path: '/waves', message: '波次数量必须在 3-10 之间' });
  return { ok: !errors.length, errors, warnings: [] };
}

function makeAdjustment(text) {
  const hard = /狠|刺激|难|多/.test(text), easy = /放水|简单|轻松|少/.test(text);
  return { command: 'adjust_next_wave', params: { count_mul_bps: hard ? 14000 : easy ? 7500 : 10500, health_mul_bps: hard ? 12000 : easy ? 8500 : 10000, speed_mul_bps: hard ? 11200 : easy ? 9000 : 10000, gold_mul_bps: hard ? 12500 : easy ? 8500 : 10500 }, say_to_player: hard ? '军令已定：下一波兵力与体魄提升，击破后的军粮也会增加。' : easy ? '先稳阵脚：下一波兵力和体魄都会收敛。' : '下一波小幅调整，风险与军粮同步变化。' };
}
function validateAdjust(a) {
  const bounds = { count_mul_bps: [5000,30000], health_mul_bps: [5000,30000], speed_mul_bps: [7000,20000], gold_mul_bps: [5000,30000] };
  const errors = Object.entries(bounds).filter(([k,[lo,hi]]) => !Number.isInteger(a?.params?.[k]) || a.params[k] < lo || a.params[k] > hi).map(([k]) => ({ code: 'VALUE_OUT_OF_RANGE', path: `/params/${k}` }));
  return { ok: a?.command === 'adjust_next_wave' && !errors.length, errors };
}

class Runtime {
  constructor(pack, seed = 20260826) {
    this.p = pack; this.tick = 0; this.gold = pack.map.starting_gold; this.base = pack.map.base.max_health; this.enemyBase = 6;
    this.wave = -1; this.phase = 'build'; this.towers = []; this.bench = []; this.unlocked = 6; this.recruitCount = 0;
    this.enemies = []; this.pending = []; this.plans = []; this.adjust = null; this.events = []; this.shots = []; this.impacts = [];
    this.kills = 0; this.leaks = 0; this.id = 1; this.rng = seed >>> 0; this.path = this.pathData();
  }
  pathData() { let total = 0, seg = []; const p = this.p.map.path; for (let i=1;i<p.length;i++) { const a=p[i-1],b=p[i],len=(Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1]))*1000; seg.push({a,b,len,start:total}); total+=len; } return {seg,total}; }
  pos(dist) { const s=this.path.seg.find(x=>dist<=x.start+x.len)||this.path.seg.at(-1),u=clamp((dist-s.start)/s.len,0,1); return [s.a[0]+(s.b[0]-s.a[0])*u+.5,s.a[1]+(s.b[1]-s.a[1])*u+.5]; }
  random() { let x=this.rng; x^=x<<13;x^=x>>>17;x^=x<<5;this.rng=x>>>0;return this.rng/4294967296; }
  recruitCost() { return Math.min(24, 8 + this.recruitCount * 2); }
  recruit() {
    const cost=this.recruitCost(); if (this.gold<cost || this.bench.length>=5 || ['win','lose'].includes(this.phase)) return false;
    this.gold-=cost;this.recruitCount++;const roll=this.random();let type,kind='unit';
    if(roll<.07){type='shovel';kind='shovel';}
    else if(roll<.25){type=Object.keys(LETTERS)[Math.floor(this.random()*6)];kind='letter';}
    else type=['blade','spear','bow','horse'][Math.floor(this.random()*4)];
    this.bench.push({id:this.id++,type,kind,level:1});this.events.push(`征得「${this.label(type)}」`);return true;
  }
  label(type) { return type==='shovel'?'铲':LETTERS[type]||UNIT_DEFS[type]?.glyph||'?'; }
  addUnit(type, slot, level=1) { if(slot<0||slot>=this.unlocked||this.towers.some(t=>t.slot===slot)||!UNIT_DEFS[type])return false;const cell=this.p.map.buildable_cells[slot];this.towers.push({id:this.id++,type,def:UNIT_DEFS[type],kind:'unit',level,slot,cell,cd:0,angle:-Math.PI/2,lastFire:-99});return true; }
  addLetter(type, slot) { if(slot<0||slot>=this.unlocked||this.towers.some(t=>t.slot===slot))return false;this.towers.push({id:this.id++,type,kind:'letter',level:1,slot,cell:this.p.map.buildable_cells[slot],cd:0});return true; }
  useShovel(cardId) { const i=this.bench.findIndex(c=>c.id===cardId&&c.kind==='shovel');if(i<0||this.unlocked>=12)return false;this.bench.splice(i,1);this.unlocked++;this.events.push('铲开一处新阵位');return true; }
  placeBench(cardId, slot) {
    const i=this.bench.findIndex(c=>c.id===cardId);if(i<0||slot<0||slot>=this.unlocked)return false;const card=this.bench[i];if(card.kind==='shovel')return this.useShovel(cardId);
    const target=this.towers.find(t=>t.slot===slot);
    if(!target){this.bench.splice(i,1);const ok=card.kind==='letter'?this.addLetter(card.type,slot):this.addUnit(card.type,slot,card.level);if(card.kind==='letter')this.checkAdjacentHero(slot);return ok;}
    if(card.kind==='unit'&&target.kind==='unit'&&card.type===target.type&&card.level===target.level&&target.level<5){this.bench.splice(i,1);target.level++;target.cd=0;this.events.push(`「${this.label(target.type)}」合为 ${target.level} 阶`);return true;}
    const hero=HERO_PAIRS[`${card.type}+${target.type}`];if(card.kind==='letter'&&target.kind==='letter'&&hero){this.bench.splice(i,1);this.promoteHero(target,hero);return true;}return false;
  }
  moveOrMerge(from, to) {
    if(from===to||to<0||to>=this.unlocked)return false;const source=this.towers.find(t=>t.slot===from),target=this.towers.find(t=>t.slot===to);if(!source)return false;
    if(!target){source.slot=to;source.cell=this.p.map.buildable_cells[to];if(source.kind==='letter')this.checkAdjacentHero(to);return true;}
    if(source.kind==='unit'&&target.kind==='unit'&&source.type===target.type&&source.level===target.level&&target.level<5){target.level++;target.cd=0;this.towers=this.towers.filter(t=>t!==source);this.events.push(`「${this.label(target.type)}」合为 ${target.level} 阶`);return true;}
    const hero=HERO_PAIRS[`${source.type}+${target.type}`];if(source.kind==='letter'&&target.kind==='letter'&&hero){this.towers=this.towers.filter(t=>t!==source);this.promoteHero(target,hero);return true;}return false;
  }
  promoteHero(target, hero) { target.type=hero;target.kind='unit';target.def=UNIT_DEFS[hero];target.level=1;target.cd=0;this.events.push(`金字相合，武将「${UNIT_DEFS[hero].glyph}」入阵！`); }
  checkAdjacentHero(slot) { const source=this.towers.find(t=>t.slot===slot&&t.kind==='letter');if(!source)return false;const row=Math.floor(slot/4),other=this.towers.find(t=>t.kind==='letter'&&Math.floor(t.slot/4)===row&&Math.abs(t.slot-slot)===1&&HERO_PAIRS[`${source.type}+${t.type}`]);if(!other)return false;const hero=HERO_PAIRS[`${source.type}+${other.type}`];this.towers=this.towers.filter(t=>t!==other);this.promoteHero(source,hero);return true; }
  discard(cardId) { const i=this.bench.findIndex(c=>c.id===cardId);if(i<0)return false;this.bench.splice(i,1);this.gold+=2;return true; }
  startWave() {
    if(this.phase!=='build'||this.wave>=this.p.waves.length-1)return false;this.wave++;const m=this.adjust||{count_mul_bps:10000,health_mul_bps:10000,speed_mul_bps:10000,gold_mul_bps:10000};this.adjust=null;this.plans=[];
    for(const group of this.p.waves[this.wave].groups){const d=this.p.enemies.find(e=>e.id===group.enemy_id),count=Math.ceil(group.count*m.count_mul_bps/10000);this.plans.push({d,left:count,interval:group.interval_ticks,next:this.tick,hp:Math.ceil(d.components.Health.max*m.health_mul_bps/10000),speed:Math.ceil(d.components.Movement.speed_milli_per_tick*m.speed_mul_bps/10000),gold:Math.ceil(d.components.Reward.gold*m.gold_mul_bps/10000)});}
    this.phase='battle';this.events.push(`第 ${this.wave+1} 阵敌军来袭`);return true;
  }
  setAdjust(a) { if(this.phase!=='build'||this.wave<0||!validateAdjust(a).ok)return false;this.adjust=a.params;return true; }
  remaining() { return this.enemies.length+this.pending.length+this.plans.reduce((n,p)=>n+p.left,0); }
  stats(t) { const scale=Math.pow(1.72,t.level-1);return {damage:Math.ceil(t.def.damage*scale),range:t.def.range,interval:Math.max(6,Math.floor(t.def.interval/(1+(t.level-1)*.18)))}; }
  attack(t) {
    if(t.kind!=='unit')return;const a=this.stats(t),from=[t.cell[0]+.5,t.cell[1]+.5];let candidates=this.enemies.filter(e=>!e.escape).filter(e=>{const p=this.pos(e.dist);return Math.hypot(p[0]-from[0],p[1]-from[1])*1000<=a.range;}).sort((x,y)=>y.dist-x.dist);if(!candidates.length)return;
    let targets=t.type==='zhaoyun'?candidates.slice(0,2):t.type==='huangzhong'?candidates.slice(0,3):[candidates[0]];
    if(t.type==='zhangfei')targets=this.enemies.filter(e=>Math.abs(e.dist-candidates[0].dist)<1500);
    for(const target of targets){const to=this.pos(target.dist);target.hp-=a.damage;target.hitTick=this.tick;if(t.type==='zhangfei')target.dist=Math.max(0,target.dist-180);this.shots.push({kind:t.type,from,to});}
    const lead=this.pos(candidates[0].dist);t.angle=Math.atan2(lead[1]-from[1],lead[0]-from[0]);t.lastFire=this.tick;t.cd=a.interval;
  }
  step() {
    this.events=[];this.shots=[];this.impacts=[];this.pending.forEach(e=>this.enemies.push(e));this.pending=[];
    if(this.phase==='battle'){
      for(const q of this.plans)if(q.left&&this.tick>=q.next){q.left--;q.next+=q.interval;this.pending.push({id:this.id++,d:q.d,hp:q.hp,maxHp:q.hp,speed:q.speed,gold:q.gold,dist:0,hitTick:-99});}
      for(const e of this.enemies)e.dist+=e.speed;
      for(const e of this.enemies.filter(e=>e.dist>=this.path.total)){e.escape=true;this.base-=e.d.components.PathFollower.base_damage;this.leaks++;this.impacts.push({kind:'base',at:this.pos(this.path.total)});}
      for(const t of this.towers){if(t.cd>0)t.cd--;else this.attack(t);}
      for(const e of this.enemies.filter(e=>e.hp<=0&&!e.escape)){e.dead=true;this.gold+=e.gold;this.kills++;this.impacts.push({kind:'death',at:this.pos(e.dist)});}
      this.enemies=this.enemies.filter(e=>!e.dead&&!e.escape);
      if(this.base<=0){this.phase='lose';this.events.push('少主失守');}
      else if(!this.plans.some(q=>q.left)&&!this.pending.length&&!this.enemies.length){this.enemyBase=Math.max(0,this.enemyBase-2);if(this.enemyBase<=0||this.wave===this.p.waves.length-1){this.phase='win';this.events.push('敌阵少主已破');}else{this.phase='build';this.gold+=12;this.events.push('敌军暂退，获军粮 12');}}
    }
    this.tick++;
  }
}

*/
const canvas=byId('board'),ctx=canvas.getContext('2d');
const sprites={};if(typeof Image!=='undefined'){const impact=new Image();impact.src='assets/game/impact.png';sprites.impact=impact;}
let pack,game,last=0,raf,speed=1,paused=false,soundOn=true,audioCtx,lastSound=0,selected=null,visualFx=[],finishShown=false;
const view = () => game?.snapshot();
function ensureAudio(){if(!soundOn)return;if(audioCtx){audioCtx.resume?.();return;}const A=window.AudioContext||window.webkitAudioContext;if(A){audioCtx=new A();audioCtx.resume?.();}}
function sound(freq,d=.04,v=.025){if(!soundOn||!audioCtx||audioCtx.state!=='running')return;const now=audioCtx.currentTime;if(now-lastSound<.016)return;lastSound=now;const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type='triangle';o.frequency.setValueAtTime(freq,now);g.gain.setValueAtTime(v,now);g.gain.exponentialRampToValueAtTime(.0001,now+d);o.connect(g).connect(audioCtx.destination);o.start(now);o.stop(now+d);}
function collectFx(){const now=performance.now();for(const s of game.shots){visualFx.push({...s,born:now,life:s.kind==='zhangfei'?260:150});sound(s.kind==='bow'||s.kind==='huangzhong'?480:s.kind==='zhangfei'?100:260,s.kind==='zhangfei'?.1:.04);}for(const e of game.impacts){visualFx.push({...e,born:now,life:300});if(e.kind==='death')sound(75,.08,.03);}}
function showToast(text){const el=byId('toast');el.textContent=text;el.classList.add('visible');setTimeout(()=>el.classList.remove('visible'),1800);}

function generate(){pack=TowerDefenseRuntime.makePack(byId('idea').value);const result=TowerDefenseRuntime.validatePack(pack);if(!result.ok){byId('ai-status').textContent=result.errors.map(e=>e.path).join('、')+' 未通过校验';return;}byId('ai-status').textContent='内容包已通过结构、语义和数值护栏。';byId('design-card').innerHTML=`<p class="eyebrow">军师回报 · 校验通过</p><h3>${pack.meta.theme}</h3><p>${pack.meta.description}</p><div class="design-grid"><div><b>征兵池</b><p>${['刀','枪','弓','骑','赵','云','张','飞','黄','忠','铲'].map(x=>`<span class="chip">${x}</span>`).join('')}</p></div><div><b>成将法</b><p><span class="chip">赵 + 云</span><span class="chip">张 + 飞</span><span class="chip">黄 + 忠</span></p></div></div><p class="muted">三阵敌军 · 双方各六命 · 初始六格阵地 · 征兵费用逐次增加</p><div class="design-actions"><button id="start" class="primary">开阵</button><button id="revise">再议</button></div>`;byId('design-card').classList.remove('hidden');byId('start').onclick=start;byId('revise').onclick=()=>byId('idea').focus();}
function start(){game=new TowerDefenseRuntime.Runtime(pack);selected=null;visualFx=[];speed=1;paused=false;finishShown=false;byId('speed').textContent='速度 ×1';byId('pause').textContent='暂停';byId('result').classList.add('hidden');byId('creator').classList.add('hidden');byId('game').classList.remove('hidden');renderFormation();cancelAnimationFrame(raf);last=performance.now();raf=requestAnimationFrame(loop);}

const generateContent = generate;
generate = () => { generateContent(); if (pack && TowerDefenseRuntime.validatePack(pack).ok) { const report = TowerDefenseRuntime.dryRun(pack); byId('ai-status').textContent = `内容包已通过校验；预演：${report.phase === 'win' ? '基础布防可通关' : '建议调整数值'}，基地余 ${report.base} 命，${report.ticks} tick。`; } };
function cardHtml(card){const cls=card.kind==='letter'?'letter':card.kind==='shovel'?'shovel':'';return `<div class="card ${cls} ${selected?.kind==='bench'&&selected.id===card.id?'selected':''}" draggable="true" data-card="${card.id}">${TowerDefenseRuntime.label(card.type)}<small>${card.kind==='unit'?'Ⅰ':''}</small></div>`;}
function unitHtml(t){return `<div class="unit ${t.hero?'hero':''} ${selected?.kind==='slot'&&selected.slot===t.slot?'selected':''}" draggable="true" data-source-slot="${t.slot}" data-level="${t.level}">${t.glyph}<small>${t.kind==='unit'?`${t.level}阶`:'待字'}</small></div>`;}
function renderFormation(){if(!game)return;const s=view();byId('bench').innerHTML=s.bench.map(cardHtml).join('')||'<span class="muted">待命区为空</span>';byId('formation').innerHTML=Array.from({length:12},(_,i)=>{const t=s.towers.find(x=>x.slot===i),locked=i>=s.unlocked;return `<div class="slot ${locked?'locked':''}" data-slot="${i}">${t?unitHtml(t):''}</div>`;}).join('');byId('slots-copy').textContent=`${s.unlocked}/12 格已开`;
  document.querySelectorAll('.card').forEach(el=>{el.onclick=()=>{const id=Number(el.dataset.card),card=s.bench.find(c=>c.id===id);if(card?.kind==='shovel'){game.useShovel(id);selected=null;renderFormation();updateUI();showToast('新阵位已开启');}else{selected={kind:'bench',id};renderFormation();}};el.ondragstart=e=>e.dataTransfer.setData('text/plain',`bench:${el.dataset.card}`);});
  document.querySelectorAll('.unit').forEach(el=>{el.onclick=e=>{e.stopPropagation();selected={kind:'slot',slot:Number(el.dataset.sourceSlot)};renderFormation();};el.ondragstart=e=>e.dataTransfer.setData('text/plain',`slot:${el.dataset.sourceSlot}`);});
  document.querySelectorAll('.slot').forEach(el=>{const slot=Number(el.dataset.slot);el.ondragover=e=>e.preventDefault();el.ondrop=e=>{e.preventDefault();deploy(e.dataTransfer.getData('text/plain'),slot);};el.onclick=()=>{if(selected)deploy(`${selected.kind}:${selected.kind==='bench'?selected.id:selected.slot}`,slot);};});
}
function deploy(source,slot){const [kind,idText]=source.split(':'),id=Number(idText);const ok=kind==='bench'?game.placeBench(id,slot):game.moveOrMerge(id,slot);if(ok){sound(320,.05,.03);selected=null;renderFormation();updateUI();showToast(game.events.at(-1)||'阵位已调整');}else showToast(slot>=game.unlocked?'此阵位尚未开拓':'不能这样合成');}
function autoBuild(){if(!game.deployStarter())return;selected=null;renderFormation();updateUI();showToast(game.events.at(-1));}

function drawImpact(x,y,size,alpha){const img=sprites.impact;if(img?.complete&&img.naturalWidth){ctx.save();ctx.globalAlpha=alpha;ctx.drawImage(img,x-size/2,y-size/2,size,size);ctx.restore();}else{ctx.strokeStyle=`rgba(142,48,39,${alpha})`;ctx.beginPath();ctx.arc(x,y,size/2,0,Math.PI*2);ctx.stroke();}}
function drawFx(now,cw,ch){visualFx=visualFx.filter(f=>now-f.born<f.life);for(const f of visualFx){const p=clamp((now-f.born)/f.life,0,1);if(f.from){const x=(f.from[0]+(f.to[0]-f.from[0])*p)*cw,y=(f.from[1]+(f.to[1]-f.from[1])*p)*ch;ctx.strokeStyle=f.kind==='bow'||f.kind==='huangzhong'?'#8b4f23':'#f0d184';ctx.lineWidth=f.kind==='zhangfei'?7:2;ctx.beginPath();ctx.moveTo(f.from[0]*cw,f.from[1]*ch);ctx.lineTo(x,y);ctx.stroke();ctx.fillStyle='#2a261e';ctx.font=f.kind==='zhangfei'?'bold 28px serif':'bold 17px serif';ctx.fillText(f.kind==='bow'||f.kind==='huangzhong'?'➶':f.kind==='zhangfei'?'喝':'•',x-6,y+5);if(p>.72)drawImpact(f.to[0]*cw,f.to[1]*ch,20+30*p,1-p);}else{drawImpact(f.at[0]*cw,f.at[1]*ch,28+50*p,1-p);}}}
function render(now=performance.now()){const snapshot=view(),game={...snapshot,label:TowerDefenseRuntime.label,stats:t=>({range:t.range_milli})};const cw=canvas.width/12,ch=canvas.height/6,p=pack.map;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle=pack.palette.ground;ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#27282012';for(let i=0;i<24;i++){ctx.beginPath();ctx.moveTo((i*113)%864,0);ctx.quadraticCurveTo((i*51)%864,210,(i*197)%864,432);ctx.stroke();}ctx.strokeStyle='#776c5988';ctx.lineWidth=1;for(let x=0;x<=12;x++){ctx.beginPath();ctx.moveTo(x*cw,0);ctx.lineTo(x*cw,canvas.height);ctx.stroke()}for(let y=0;y<=6;y++){ctx.beginPath();ctx.moveTo(0,y*ch);ctx.lineTo(canvas.width,y*ch);ctx.stroke()}ctx.strokeStyle=pack.palette.path;ctx.lineWidth=42;ctx.lineCap='round';ctx.beginPath();p.path.forEach((q,i)=>i?ctx.lineTo((q[0]+.5)*cw,(q[1]+.5)*ch):ctx.moveTo((q[0]+.5)*cw,(q[1]+.5)*ch));ctx.stroke();ctx.fillStyle='#5f2c25';ctx.font='bold 28px serif';ctx.fillText('少主',canvas.width-72,2.5*ch+10);
  if(selected?.kind==='slot'){const t=game.towers.find(t=>t.slot===selected.slot);if(t?.kind==='unit'){const a=game.stats(t),x=(t.cell[0]+.5)*cw,y=(t.cell[1]+.5)*ch;ctx.fillStyle='#f4e8b51c';ctx.strokeStyle='#8c6c31aa';ctx.beginPath();ctx.arc(x,y,a.range/1000*cw,0,Math.PI*2);ctx.fill();ctx.stroke();}}
  for(const t of game.towers){const x=(t.cell[0]+.5)*cw,y=(t.cell[1]+.5)*ch,recoil=game.tick-(t.lastFire??-99)<3?5:0;ctx.save();ctx.translate(x-Math.cos(t.angle||0)*recoil,y-Math.sin(t.angle||0)*recoil);ctx.fillStyle=t.color;ctx.strokeStyle=t.kind==='letter'?'#a57b25':'#ede1c4';ctx.lineWidth=3;ctx.beginPath();ctx.arc(0,0,t.hero?31:25,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle=t.kind==='letter'?'#8a631f':'#f5ead1';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`${t.hero?'bold 22px':'bold 28px'} 'Noto Serif SC',serif`;ctx.fillText(t.glyph,0,0);ctx.textAlign='start';ctx.textBaseline='alphabetic';ctx.restore();if(game.tick-(t.lastFire??-99)<2){ctx.fillStyle='#fff0a4';ctx.beginPath();ctx.arc(x+Math.cos(t.angle)*28,y+Math.sin(t.angle)*28,6,0,Math.PI*2);ctx.fill();}}
  for(const e of game.enemies){let[x,y]=e.pos;x*=cw;y=y*ch+Math.sin((game.tick+e.id)*.14)*2;ctx.fillStyle=e.captain?'#73332d':'#31332e';ctx.beginPath();ctx.arc(x,y,e.captain?24:18,0,Math.PI*2);ctx.fill();ctx.fillStyle='#efe2c6';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=e.captain?'bold 24px serif':'bold 19px serif';ctx.fillText(e.glyph,x,y);ctx.textAlign='start';ctx.textBaseline='alphabetic';ctx.fillStyle='#352d27';ctx.fillRect(x-20,y-31,40,4);ctx.fillStyle='#a64035';ctx.fillRect(x-20,y-31,40*clamp(e.hp/e.maxHp,0,1),4);}drawFx(now,cw,ch);if(paused){ctx.fillStyle='#171813aa';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#f0dfb8';ctx.textAlign='center';ctx.font='bold 36px serif';ctx.fillText('战局暂停',canvas.width/2,canvas.height/2);ctx.textAlign='start';}}

function life(n){return '命'.repeat(Math.max(0,n))+'·'.repeat(Math.max(0,6-n));}
function showResult(){if(finishShown)return;finishShown=true;const won=game.phase==='win';byId('result').innerHTML=`<div><p class="eyebrow">战局结算</p><h2>${won?'破阵':'失守'}</h2><p>${won?`敌方少主命数已尽。你击破 ${game.kills} 名敌军，漏过 ${game.leaks} 名。`:`我方少主失守。本局击破 ${game.kills} 名敌军，可重新整军再战。`}</p><div class="result-actions"><button id="retry" class="primary">再战</button><button id="new-design">另议战局</button></div></div>`;byId('result').classList.remove('hidden');byId('retry').onclick=start;byId('new-design').onclick=returnToCreator;}
function updateUI(){if(!game)return;byId('gold').textContent=game.gold;byId('buns').textContent=game.gold;byId('base').textContent=life(game.base);byId('enemy-base').textContent=life(game.enemyBase);byId('wave').textContent=game.phase==='build'?`第 ${game.wave+2} 阵待命`:`第 ${game.wave+1}/3 阵`;byId('state').textContent=paused?'暂停':game.phase==='battle'?'交战中':game.phase==='win'?'破阵':game.phase==='lose'?'失守':'整军中';byId('remaining').textContent=game.phase==='battle'?game.remaining():'—';byId('recruit-cost').textContent=game.recruitCost();byId('recruit').disabled=game.gold<game.recruitCost()||game.bench.length>=5||['win','lose'].includes(game.phase);const canAdjust=game.phase==='build'&&game.wave>=0;byId('adjust-text').disabled=!canAdjust;byId('adjust').disabled=!canAdjust;byId('wave-button').disabled=game.phase!=='build'||game.wave>=2;byId('wave-button').textContent=game.phase==='build'?`迎战第 ${game.wave+2} 波`:'交战中';if(game.events.length)showToast(game.events.at(-1));if(['win','lose'].includes(game.phase))showResult();}
function loop(now){const frame=TICK_MS/speed;if(paused)last=now;while(!paused&&now-last>=frame){game.step();collectFx();last+=frame;}render(now);updateUI();if(!['win','lose'].includes(game.phase))raf=requestAnimationFrame(loop);}
function returnToCreator(){cancelAnimationFrame(raf);byId('game').classList.add('hidden');byId('creator').classList.remove('hidden');byId('result').classList.add('hidden');}

renderFormation = function(){
  if(!game)return;const s=view(),high=new Set((s.terrain||[]).filter(t=>t.tags.includes('HIGH_GROUND')).map(t=>t.cell.join(',')));
  byId('bench').innerHTML=s.bench.map(cardHtml).join('')||'<span class="muted">待命区为空</span>';
  byId('formation').innerHTML=Array.from({length:12},(_,i)=>{const t=s.towers.find(x=>x.slot===i),locked=i>=s.unlocked,cell=pack.map.buildable_cells[i],isHigh=cell&&high.has(cell.join(','));return `<div class="slot ${locked?'locked':''} ${isHigh?'high-ground':''}" data-slot="${i}" title="${isHigh?'高地：射程 +20%':''}">${t?unitHtml(t):''}</div>`;}).join('');
  byId('slots-copy').textContent=`${s.unlocked}/12 格已开`;
  document.querySelectorAll('.card').forEach(el=>{el.onclick=()=>{const id=Number(el.dataset.card),card=s.bench.find(c=>c.id===id);if(card?.kind==='shovel'){game.useShovel(id);selected=null;renderFormation();updateUI();showToast('新阵位已开启');}else{selected={kind:'bench',id};renderFormation();}};el.ondragstart=e=>e.dataTransfer.setData('text/plain',`bench:${el.dataset.card}`);});
  document.querySelectorAll('.unit').forEach(el=>{el.onclick=e=>{e.stopPropagation();selected={kind:'slot',slot:Number(el.dataset.sourceSlot)};renderFormation();};el.ondragstart=e=>e.dataTransfer.setData('text/plain',`slot:${el.dataset.sourceSlot}`);});
  document.querySelectorAll('.slot').forEach(el=>{const slot=Number(el.dataset.slot);el.ondragover=e=>e.preventDefault();el.ondrop=e=>{e.preventDefault();deploy(e.dataTransfer.getData('text/plain'),slot);};el.onclick=()=>{if(selected)deploy(`${selected.kind}:${selected.kind==='bench'?selected.id:selected.slot}`,slot);};});
};
byId('generate').onclick=generate;
byId('recruit').onclick=()=>{ensureAudio();if(game.recruit()){sound(380,.05,.03);selected={kind:'bench',id:game.bench.at(-1).id};renderFormation();updateUI();showToast(game.events.at(-1));}};
byId('auto-build').onclick=()=>{ensureAudio();autoBuild();};
byId('clear-bench').onclick=()=>{for(const c of [...game.bench])game.discard(c.id);selected=null;renderFormation();updateUI();};
byId('wave-button').onclick=()=>{ensureAudio();if(!game.towers.some(t=>t.kind==='unit'))autoBuild();game.startWave();updateUI();};
byId('speed').onclick=()=>{speed=speed===1?2:speed===2?4:1;byId('speed').textContent=`速度 ×${speed}`;last=performance.now();};
byId('pause').onclick=()=>{paused=!paused;byId('pause').textContent=paused?'继续':'暂停';last=performance.now();};
byId('sound').onclick=()=>{soundOn=!soundOn;byId('sound').textContent=`声音：${soundOn?'开':'关'}`;if(soundOn)ensureAudio();};
byId('adjust').onclick=()=>{const a=TowerDefenseRuntime.makeAdjustment(byId('adjust-text').value);if(game.setAdjust(a)){byId('adjust-reply').textContent=a.say_to_player;showToast('军令已锁定，仅作用于下一波');}};
byId('restart').onclick=returnToCreator;

function checksum(r){return JSON.stringify([r.tick,r.gold,r.base,r.enemyBase,r.wave,r.phase,r.rng,r.towers.map(t=>[t.type,t.level,t.slot]),r.enemies.map(e=>[e.id,e.hp,Math.floor(e.dist)])]);}
function regression(){const runs=[];for(let n=0;n<10;n++){const r=new TowerDefenseRuntime.Runtime(TowerDefenseRuntime.makePack('长坂坡雨夜'));r.addUnit('blade',0,2);r.addUnit('spear',1,2);r.addUnit('bow',2,2);r.addUnit('bow',3,2);r.startWave();let sawShot=false;for(let i=0;i<9000&&!['win','lose'].includes(r.phase);i++){r.step();sawShot||=r.shots.length>0;if(r.phase==='build')r.startWave();}if(r.phase!=='win'||!sawShot)return false;runs.push(checksum(r));}const oldPack=pack,oldGame=game;pack=TowerDefenseRuntime.makePack('测试');game=new TowerDefenseRuntime.Runtime(pack);try{render();}catch{return false;}finally{pack=oldPack;game=oldGame;}return runs.every(x=>x===runs[0]);}
const regressionOk=regression();byId('check').textContent=regressionOk?'完整局校验 10/10 通过':'完整局校验失败';byId('check').classList.toggle('ok',regressionOk);generate();
