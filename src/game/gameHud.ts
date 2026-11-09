import { CELL, TICKS_PER_SECOND, type BattleState, type Command } from '../runtime';
import { maxTowerLevel, towerStats } from '../runtime/upgrade';
import { PALETTES } from './palettes';
import { towerDetails, type createTooltips } from './tooltips';
import { waveDescription } from './tacticalOverlay';

export const STR = {
  zh: { base: '基地', gold: '金币', wave: '波次', build: '布防中', fight: '交战中', won: '胜利', lost: '失败', start: '出兵', restart: '重新开始', exit: '退出', theme: '主题:', held: '守住了！', fell: '基地失守', paused: '已暂停', revenge: '复仇一局', revenging: '军师出题中…' },
  en: { base: 'Base', gold: 'Gold', wave: 'Wave', build: 'Build', fight: 'Fighting', won: 'Won', lost: 'Lost', start: 'Start wave', restart: 'Restart', exit: 'Exit', theme: 'Theme:', held: 'Held!', fell: 'Base fell', paused: 'Paused', revenge: 'Revenge round', revenging: 'Advisor is designing…' },
} as const;
interface HudOptions {
  state: BattleState; read: () => BattleState; hud: HTMLElement; lang: 'zh' | 'en';
  paused: boolean; hostHidden: boolean; inLobby: boolean; speed: number; inspectedTower: number | null; selected: string;
  insitu: boolean; embedded: boolean; hikosMode: boolean; currentTheme: string; campaign: boolean; trial: boolean;
  revenging: boolean; clearedWaves: number; bestWave: number; waveScore: { kills: number; leaks: number; bounty: number };
  toast: string; tips: ReturnType<typeof createTooltips>;
  actions: {
    select(id: string): void; startWave(): void; togglePause(): void; speed(value: number): void;
    settings(): void; lobby(): void; revenge(): void; theme(id: string): void; exit(): void;
    upgrade(command: Extract<Command, { type: 'upgrade' }>): void;
  };
}
export function renderBattleHud(options: HudOptions) {
  const { state, hud, lang, paused, hostHidden, inspectedTower, selected, tips, inLobby, speed,
    hikosMode, currentTheme, revenging, clearedWaves, bestWave, waveScore, toast, actions } = options;
  const pack = state.pack;
  const t = (key: keyof typeof STR.zh) => STR[lang][key];
  const focused = document.activeElement instanceof HTMLElement && hud.contains(document.activeElement)
    ? Array.from(hud.querySelectorAll('button, select')).indexOf(document.activeElement) : -1;
  const s = state;
  const phaseText = { build: t('build'), wave: t('fight'), won: t('won'), lost: t('lost') }[s.phase];
  hud.innerHTML = '';
  const title = document.createElement('strong');
  title.className = 'battle-title';
  title.textContent = options.trial && lang === 'en' ? 'Changban · Artillery range' : pack.meta.theme;
  if (!options.insitu) hud.append(title);
  const info = document.createElement('span');
  info.className = 'stats';
  info.textContent = `${t('base')} ${s.base_hp}/${pack.map.base_hp}　${t('gold')} ${s.gold}　${t('wave')} ${s.wave_index}/${pack.waves.length}　${paused || hostHidden ? t('paused') : phaseText}`;
  hud.append(info);
  // 下一波预览：军师快照里的 wave.next 就是这一行——军师知道的，玩家同样看得见（#24353「不泄露玩家尚不可见的信息」）
  const nextWave = s.phase === 'build' ? pack.waves[s.wave_index] : null;
  if (nextWave) {
    const counts = new Map<string, number>();
    for (const g of nextWave.groups) counts.set(g.enemy_id, (counts.get(g.enemy_id) ?? 0) + g.count);
    const preview = document.createElement('span');
    preview.className = 'stats next-wave'; preview.id = 'td-next-wave';
    preview.textContent = `${lang === 'zh' ? '下一波' : 'Next'}：${[...counts].map(([id, n]) => `${pack.enemies.find((e) => e.id === id)?.display_name ?? id}×${n}`).join(lang === 'zh' ? '、' : ', ')}`;
    tips.bind(preview, () => waveDescription(options.read(), lang === 'zh'));
    hud.append(preview);
  }
  for (const tw of pack.towers) {
    const b = document.createElement('button');
    const stats = document.createElement('small');
    stats.textContent = lang === 'zh' ? `${tw.damage} 伤害 · ${(tw.interval_ticks / TICKS_PER_SECOND).toFixed(1)} 秒` : `${tw.damage} dmg · ${(tw.interval_ticks / TICKS_PER_SECOND).toFixed(1)} s`;
    const name = options.trial && lang === 'en' ? 'Heavy cannon' : tw.display_name;
    b.append(`${name} ${tw.cost}`, stats);
    b.dataset.tower = tw.id;
    b.setAttribute('aria-pressed', String(tw.id === selected && inspectedTower === null));
    if (tw.id === selected && inspectedTower === null) b.className = 'sel';
    b.disabled = s.phase === 'won' || s.phase === 'lost';
    b.onclick = () => actions.select(tw.id);
    tips.bind(b, () => towerDetails(tw, 1, undefined, lang === 'zh'));
    hud.append(b);
  }
  const w = document.createElement('button');
  w.id = 'start-wave';
  w.textContent = s.phase === 'won' || s.phase === 'lost' ? t('restart') : t('start');
  w.disabled = s.phase === 'wave' || paused;
  w.onclick = actions.startWave;
  hud.append(w);
  if (!inLobby) {
    const pause = document.createElement('button');
    pause.id = 'td-pause';
    pause.textContent = lang === 'zh' ? (paused ? '继续' : '暂停') : (paused ? 'Resume' : 'Pause');
    pause.setAttribute('aria-pressed', String(paused));
    pause.onclick = actions.togglePause;
    hud.append(pause);
    for (const value of options.trial ? [] : [1, 2, 3]) {
      const pace = document.createElement('button');
      pace.textContent = `${value}×`; pace.dataset.speed = String(value);
      pace.setAttribute('aria-pressed', String(speed === value));
      pace.onclick = () => actions.speed(value);
      hud.append(pace);
    }
    const settingsButton = document.createElement('button');
    settingsButton.id = 'td-settings'; settingsButton.textContent = lang === 'zh' ? '设置' : 'Settings';
    settingsButton.onclick = actions.settings;
    hud.append(settingsButton);
    if (!options.embedded && !options.trial) {
      const designs = document.createElement('button');
      designs.textContent = lang === 'zh' ? '设计战局' : 'Design a battle';
      designs.onclick = actions.lobby;
      hud.append(designs);
    }
  }
  if (!options.trial && (s.phase === 'won' || s.phase === 'lost')) {
    // 复仇一局（玩法增强 ③）：把这局的战报交给关卡设计军师，出一张针对你弱点的关
    const rv = document.createElement('button');
    rv.id = 'td-revenge'; rv.textContent = revenging ? t('revenging') : t('revenge'); rv.disabled = revenging;
    rv.onclick = actions.revenge;
    hud.append(rv);
  }

  if (!hikosMode && !options.trial) {
    // 独立页才有主题下拉；嵌在 Hikos 里配色由宿主皮肤决定
    const tb = document.createElement('select');
    tb.id = 'theme-select';
    for (const k of Object.keys(PALETTES)) {
      const opt = document.createElement('option'); opt.value = k; opt.textContent = t('theme') + k;
      if (k === currentTheme) opt.selected = true;
      tb.appendChild(opt);
    }
    tb.onchange = () => actions.theme(tb.value);
    hud.append(tb);
  }
  if (options.embedded) {
    const x = document.createElement('button');
    x.id = 'td-exit'; x.className = 'exit'; x.textContent = t('exit');
    x.onclick = actions.exit;
    hud.append(x);
  }

  if (toast) {
    const m = document.createElement('span'); m.className = 'toast'; m.setAttribute('role', 'status'); m.textContent = toast; hud.append(m);
  }
  const tower = s.towers.find((item) => item.iid === inspectedTower);
  const def = pack.towers.find((item) => item.id === tower?.def);
  const briefing = document.createElement('div');
  briefing.className = 'battle-briefing';
  if (tower && def && (s.phase === 'build' || s.phase === 'wave')) {
    const level = tower.level ?? 1;
    const { damage, range, upgradeCost } = towerStats(def, level, tower.branch);
    briefing.textContent = `${def.display_name} · Lv.${level}/${maxTowerLevel(def) + (tower.branch ? 1 : 0)} · ${damage} ${lang === 'zh' ? '伤害' : 'dmg'} · ${(range / CELL).toFixed(1)} ${lang === 'zh' ? '格射程' : 'cells'}`;
    if (upgradeCost !== null) {
      const next = towerStats(def, level + 1);
      const upgrade = document.createElement('button');
      upgrade.id = 'td-upgrade';
      upgrade.dataset.nextRange = String(next.range);
      upgrade.textContent = lang === 'zh' ? `升至 Lv.${level + 1} · ${upgradeCost} 金 · 伤害 ${next.damage}` : `Upgrade to Lv.${level + 1} · ${upgradeCost} gold · ${next.damage} dmg`;
      upgrade.disabled = (s.phase !== 'build' && !paused) || s.gold < upgradeCost;
      upgrade.onclick = () => {
        actions.upgrade({ type: 'upgrade', iid: tower.iid, fromLevel: level, tactical: paused });
      };
      tips.bind(upgrade, () => towerDetails(def, level + 1, undefined, lang === 'zh'));
      briefing.append(upgrade);
      if (upgrade.disabled) briefing.append(lang === 'zh' ? (s.phase !== 'build' ? '波间可升塔' : '金币不足') : (s.phase !== 'build' ? 'Upgrade between waves' : 'Not enough gold'));
    }
    if (!tower.branch && level === maxTowerLevel(def)) {
      for (const option of def.branch_upgrades ?? []) {
        const button = document.createElement('button');
        button.textContent = `${option.name} · ${option.level.upgrade_cost}`;
        button.disabled = (s.phase !== 'build' && !paused) || s.gold < option.level.upgrade_cost;
        button.onclick = () => actions.upgrade({ type: 'upgrade', iid: tower.iid, fromLevel: level, branch: option.id, tactical: paused });
        tips.bind(button, () => towerDetails(def, level, option.id, lang === 'zh'));
        briefing.append(button);
      }
    }
  } else if (!options.insitu && !inLobby) {
    const zh = lang === 'zh';
    if (s.phase === 'wave') {
      const remaining = s.enemies.length + s.spawn_queue.length;
      briefing.textContent = zh ? `剩余 ${remaining} 敌 · 击破 ${waveScore.kills} · 漏敌 ${waveScore.leaks}` : `${remaining} left · ${waveScore.kills} defeated · ${waveScore.leaks} leaked`;
    } else if (clearedWaves || s.phase === 'lost') {
      briefing.textContent = zh ? `第 ${s.wave_index} 波 · 击破 ${waveScore.kills} · 漏敌 ${waveScore.leaks} · 赏金 +${waveScore.bounty}` : `Wave ${s.wave_index} · ${waveScore.kills} defeated · ${waveScore.leaks} leaked · +${waveScore.bounty} gold`;
      if (s.phase === 'build') briefing.append(zh ? '｜点已有塔升阶' : ' | Select a tower to upgrade');
    } else {
      briefing.textContent = zh ? (s.towers.length ? '布防就绪 · 点「出兵」迎战' : options.trial ? '将重炮拖到带十字标记的炮位，或选中后点击落位。' : '选择塔卡后点空地建造，也可直接拖放塔卡') :
        (s.towers.length ? 'Defenses ready. Start the wave when ready.' : options.trial ? 'Drag the cannon to a marked pad, or select the card and click a pad.' : 'Select a tower card and click an open tile, or drag the card onto the board.');
    }
    if (options.campaign && bestWave) briefing.append(zh ? `｜最高守过 ${bestWave} 波` : ` | Best: ${bestWave} waves cleared`);
  }
  if (briefing.hasChildNodes()) hud.append(briefing);
  if (focused >= 0) hud.querySelectorAll<HTMLElement>('button, select')[focused]?.focus({ preventScroll: true });
}
