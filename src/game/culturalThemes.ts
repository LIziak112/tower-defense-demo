// 四款 3D 皮肤世界观文化设定词表、攻防打击动效规格与策略趣味化配置（任务 5442637d / 大厅 #26153）。
// 1. 彻底替换「军师议事 / 弩车 / 投石车 / 火油台 / 步卒 / 轻骑 / 重甲」等古代中国称谓，按四款皮肤各自世界观集中配置、实时切换；
// 2. 每款皮肤定义专属攻击弹道（脉冲棱镜光束 / 电磁电弧 / 圣光裁决箭 / 岸防高爆炮火）、炮口闪光、后坐力微弹及受击反馈参数；
// 3. 以席德·梅尔「游戏是一系列有意思的抉择（Interesting Decisions）」为设计视角，提供开战前参谋敕令三选一、兵种克制、路线分流与可选危机挑战词缀。
import type { ContentPack, GambitId } from '../runtime/types';

export type SkinId = 'union-atlas-3d' | 'metropolis-riverside-3d' | 'gothic-cathedral-3d' | 'harbor-district-3d';

export type ProjectileStyle = 'prism_beam' | 'emp_arc' | 'holy_lance' | 'naval_shell';

export interface TowerCultureSpec {
  id: string;
  legacyZh: string;
  zh: string;
  en: string;
  weaponZh: string;
  weaponEn: string;
  roleZh: string;
  roleEn: string;
  counterTrait: 'shield' | 'speed' | 'armor';
}

export interface EnemyCultureSpec {
  id: string;
  legacyZh: string;
  zh: string;
  en: string;
  trait: 'shield' | 'speed' | 'armor';
  traitLabelZh: string;
  traitLabelEn: string;
  counteredByZh: string;
  counteredByEn: string;
}

export interface EdictOptionSpec {
  id: 'overclock' | 'bounty_lure' | 'fortify_grid';
  name: { zh: string; en: string };
  upside: { zh: string; en: string };
  downside: { zh: string; en: string };
  towerDamageMul: number;
  towerIntervalMul: number;
  enemySpeedMul: number;
  rewardBonusCp: number;
  startingGoldDelta: number;
  baseHpDelta: number;
}

export interface CrisisAffixSpec {
  id: 'emp_fog' | 'vanguard_surge' | 'armored_escort';
  name: { zh: string; en: string };
  desc: { zh: string; en: string };
  ratingBonus: number;
  towerRangeMul: number;
  enemySpeedMul: number;
  enemyHpMul: number;
}

export interface SkinCulturalLexicon {
  skin: SkinId;
  worldTitle: { zh: string; en: string };
  councilTitle: { zh: string; en: string };
  advisorRole: { zh: string; en: string };
  advisorGlyph: { zh: string; en: string };
  baseTitle: { zh: string; en: string };
  spawnTitle: { zh: string; en: string };
  waveLabel: { zh: string; en: string };
  startAction: { zh: string; en: string };
  gambitTitle: { zh: string; en: string };
  gambitNames: Record<GambitId, { zh: string; en: string; lineZh: string; lineEn: string }>;
  edictTitle: { zh: string; en: string };
  edicts: EdictOptionSpec[];
  affixTitle: { zh: string; en: string };
  affixes: CrisisAffixSpec[];
  routeSplitLabel: { zh: string; en: string };
  towers: Record<string, TowerCultureSpec>;
  enemies: Record<string, EnemyCultureSpec>;
  presets: { label: string; prompt: string }[];
  placeholder: { zh: string; en: string };
  vfx: {
    projectileStyle: ProjectileStyle;
    muzzleColor: string;
    beamCoreColor: string;
    beamGlowColor: string;
    shieldColor: string;
    critColor: string;
    recoilPx: number;
    hitStopMs: number;
    screenShakePx: number;
  };
}

export const SKIN_CULTURAL_LEXICONS: Record<SkinId, SkinCulturalLexicon> = {
  'union-atlas-3d': {
    skin: 'union-atlas-3d',
    worldTitle: { zh: '星院联邦 · 工业星图', en: 'Union Atlas Directorate' },
    councilTitle: { zh: '星院参谋庭', en: 'Star-Council Briefing' },
    advisorRole: { zh: '星院首席参谋', en: 'Chief Astral Tactician' },
    advisorGlyph: { zh: '参', en: 'A' },
    baseTitle: { zh: '中央星核母站', en: 'Central Astral Core' },
    spawnTitle: { zh: '西翼裂隙信标', en: 'West Rift Beacon' },
    waveLabel: { zh: '星轨波次', en: 'Orbital Wave' },
    startAction: { zh: '启动拦截', en: 'Engage Intercept' },
    gambitTitle: { zh: '星院调度令', en: 'Astral Directive' },
    gambitNames: {
      swarm: { zh: '裂隙增幅令', en: 'Rift Surge', lineZh: '下波敌舰群密度 +50%', lineEn: 'Next wave: +50% fleet density' },
      tight: { zh: '跃迁急行令', en: 'Warp Rush', lineZh: '下波敌舰跃迁间隔减半', lineEn: 'Next wave: 2x warp cadence' },
      tough: { zh: '重装护盾令', en: 'Phase Plating', lineZh: '下波敌舰护盾结构 +40%', lineEn: 'Next wave: +40% hull integrity' },
    },
    edictTitle: { zh: '战前参谋敕令（三选一）', en: 'Pre-Battle Council Edict (Pick 1)' },
    edicts: [
      {
        id: 'overclock',
        name: { zh: '棱镜超频协议', en: 'Prism Overclock' },
        upside: { zh: '防卫塔单发伤害 +25%', en: 'Tower damage +25%' },
        downside: { zh: '冷却充能间隔 +15%', en: 'Tower cooldown +15%' },
        towerDamageMul: 1.25, towerIntervalMul: 1.15, enemySpeedMul: 1.0, rewardBonusCp: 0, startingGoldDelta: 0, baseHpDelta: 0,
      },
      {
        id: 'bounty_lure',
        name: { zh: '高危信标诱敌', en: 'Beacon Lure' },
        upside: { zh: '开局立得 +35 CP 算力拨款', en: 'Immediate +35 CP grant' },
        downside: { zh: '敌舰巡航推进速度 +15%', en: 'Enemy speed +15%' },
        towerDamageMul: 1.0, towerIntervalMul: 1.0, enemySpeedMul: 1.15, rewardBonusCp: 2, startingGoldDelta: 35, baseHpDelta: 0,
      },
      {
        id: 'fortify_grid',
        name: { zh: '星核屏障加固', en: 'Core Aegis Grid' },
        upside: { zh: '母站护盾上限 +6、射速 +10%', en: 'Core HP +6, fire rate +10%' },
        downside: { zh: '开局可用算力 -20 CP', en: 'Starting CP -20' },
        towerDamageMul: 1.0, towerIntervalMul: 0.9, enemySpeedMul: 1.0, rewardBonusCp: 0, startingGoldDelta: -20, baseHpDelta: 6,
      },
    ],
    affixTitle: { zh: '危机挑战词缀', en: 'Crisis Affixes' },
    affixes: [
      { id: 'emp_fog', name: { zh: '磁暴盲区', en: 'Ion Storm' }, desc: { zh: '防卫塔索敌射程 -12%（评级 +1）', en: 'Tower range -12% (+1 Rank)' }, ratingBonus: 1, towerRangeMul: 0.88, enemySpeedMul: 1, enemyHpMul: 1 },
      { id: 'vanguard_surge', name: { zh: '极速闪击', en: 'Warp Blitz' }, desc: { zh: '敌军推进速度 +18%（评级 +1）', en: 'Enemy speed +18% (+1 Rank)' }, ratingBonus: 1, towerRangeMul: 1, enemySpeedMul: 1.18, enemyHpMul: 1 },
      { id: 'armored_escort', name: { zh: '重装护航', en: 'Dreadnought Escort' }, desc: { zh: '敌军结构耐久 +22%（评级 +1）', en: 'Enemy HP +22% (+1 Rank)' }, ratingBonus: 1, towerRangeMul: 1, enemySpeedMul: 1, enemyHpMul: 1.22 },
    ],
    routeSplitLabel: { zh: '北翼星轨主干 / 南翼栈桥支线分流', en: 'North Orbital Trunk / South Causeway Split' },
    towers: {
      crossbow: { id: 'crossbow', legacyZh: '弩车', zh: '脉冲棱镜塔', en: 'Pulse Prism Turret', weaponZh: '高频相位光束', weaponEn: 'Phase Laser Beam', roleZh: '高频破盾', roleEn: 'Anti-Shield Rapid', counterTrait: 'shield' },
      catapult: { id: 'catapult', legacyZh: '投石车', zh: '轨道天基炮', en: 'Orbital Rail Cannon', weaponZh: '天基重型动能弹', weaponEn: 'Kinetic Mass Shell', roleZh: '重型破甲', roleEn: 'Heavy Armor Piercer', counterTrait: 'armor' },
      fire_brazier: { id: 'fire_brazier', legacyZh: '火油台', zh: '引力锚定井', en: 'Gravity Anchor Well', weaponZh: '引力湍流场', weaponEn: 'Gravity Eddy Field', roleZh: '压制快艇', roleEn: 'Interceptor Suppressor', counterTrait: 'speed' },
      thorn: { id: 'thorn', legacyZh: '荆棘塔', zh: '脉冲棱镜塔', en: 'Pulse Prism Turret', weaponZh: '高频相位光束', weaponEn: 'Phase Laser Beam', roleZh: '高频破盾', roleEn: 'Anti-Shield Rapid', counterTrait: 'shield' },
      poison: { id: 'poison', legacyZh: '毒雾塔', zh: '引力锚定井', en: 'Gravity Anchor Well', weaponZh: '引力湍流场', weaponEn: 'Gravity Eddy Field', roleZh: '压制快艇', roleEn: 'Interceptor Suppressor', counterTrait: 'speed' },
      stone: { id: 'stone', legacyZh: '石像塔', zh: '轨道天基炮', en: 'Orbital Rail Cannon', weaponZh: '天基重型动能弹', weaponEn: 'Kinetic Mass Shell', roleZh: '重型破甲', roleEn: 'Heavy Armor Piercer', counterTrait: 'armor' },
    },
    enemies: {
      footman: { id: 'footman', legacyZh: '步卒', zh: '相位护盾巡逻机', en: 'Phase-Shield Drone', trait: 'shield', traitLabelZh: '相位护盾', traitLabelEn: 'Phase Shield', counteredByZh: '脉冲棱镜塔（高频破盾 ×1.35）', counteredByEn: 'Pulse Prism (×1.35 vs Shield)' },
      light_cavalry: { id: 'light_cavalry', legacyZh: '轻骑', zh: '裂隙闪击快艇', en: 'Rift Skiff', trait: 'speed', traitLabelZh: '跃迁闪击', traitLabelEn: 'Warp Skirmish', counteredByZh: '引力锚定井（湍流截击 ×1.35）', counteredByEn: 'Gravity Well (×1.35 vs Fast)' },
      heavy_armor: { id: 'heavy_armor', legacyZh: '重甲', zh: '暗物质重装舰', en: 'Dark-Matter Dreadnought', trait: 'armor', traitLabelZh: '重装舰体', traitLabelEn: 'Heavy Hull', counteredByZh: '轨道天基炮（动能破甲 ×1.35）', counteredByEn: 'Orbital Cannon (×1.35 vs Armor)' },
      bog_golem: { id: 'bog_golem', legacyZh: '泥沼巨人', zh: '泰坦工程机甲', en: 'Titan Siege Mech', trait: 'armor', traitLabelZh: '反应堆重甲', traitLabelEn: 'Reactor Armor', counteredByZh: '轨道天基炮（动能破甲 ×1.35）', counteredByEn: 'Orbital Cannon (×1.35 vs Armor)' },
      swamp_frog: { id: 'swamp_frog', legacyZh: '沼泽蛙', zh: '跃迁突击飞梭', en: 'Warp Assault Shuttle', trait: 'speed', traitLabelZh: '微跃迁机动', traitLabelEn: 'Micro-Warp', counteredByZh: '引力锚定井（湍流截击 ×1.35）', counteredByEn: 'Gravity Well (×1.35 vs Fast)' },
      miasma_bug: { id: 'miasma_bug', legacyZh: '瘴气虫', zh: '纳米干扰蜂群', en: 'Nano-Swarm Drone', trait: 'shield', traitLabelZh: '集群偏导屏', traitLabelEn: 'Swarm Barrier', counteredByZh: '脉冲棱镜塔（高频破盾 ×1.35）', counteredByEn: 'Pulse Prism (×1.35 vs Shield)' },
    },
    presets: [
      { label: '星环磁暴防御', prompt: '星环磁暴夜，裂隙闪击快艇突袭' },
      { label: '栈桥双路合围', prompt: '跨区栈桥分流，无人机集群压境' },
      { label: '重装舰队攻坚', prompt: '暗物质重装舰压阵，高CP算力奖励' },
    ],
    placeholder: { zh: '输入战术推演构想，例如：星环磁暴夜，裂隙闪击快艇突袭', en: 'Enter tactical brief, e.g. Ion storm raid with rift skiffs' },
    vfx: {
      projectileStyle: 'prism_beam',
      muzzleColor: '#ffdfd0',
      beamCoreColor: '#ffffff',
      beamGlowColor: '#d94b3d',
      shieldColor: '#5ec8ff',
      critColor: '#ff5238',
      recoilPx: 4.5,
      hitStopMs: 42,
      screenShakePx: 4.0,
    },
  },
  'metropolis-riverside-3d': {
    skin: 'metropolis-riverside-3d',
    worldTitle: { zh: '滨江都会 · 智控防区', en: 'Riverside Metropolis Grid' },
    councilTitle: { zh: '市政防务调度中心', en: 'Metro Defense Dispatch' },
    advisorRole: { zh: '市政智控调度总监', en: 'Metro AI Dispatcher' },
    advisorGlyph: { zh: '调', en: 'M' },
    baseTitle: { zh: '滨江算力中枢大厦', en: 'Riverside Compute Tower' },
    spawnTitle: { zh: '北翼高架匝道口', en: 'North Skyway Ramp' },
    waveLabel: { zh: '车流潮汐', en: 'Traffic Surge' },
    startAction: { zh: '下达封控', en: 'Deploy Blockade' },
    gambitTitle: { zh: '市政应急调度令', en: 'Metro Emergency Order' },
    gambitNames: {
      swarm: { zh: '高峰并线令', en: 'Peak Merge', lineZh: '下波无人车队规模 +50%', lineEn: 'Next wave: +50% convoy volume' },
      tight: { zh: '绿波放行令', en: 'Green-Wave Rush', lineZh: '下波车流发车间隔减半', lineEn: 'Next wave: 2x dispatch rate' },
      tough: { zh: '复合装甲令', en: 'Reactive Plating', lineZh: '下波装甲车体耐久 +40%', lineEn: 'Next wave: +40% chassis armor' },
    },
    edictTitle: { zh: '战前参谋敕令（三选一）', en: 'Pre-Battle Dispatch Edict (Pick 1)' },
    edicts: [
      {
        id: 'overclock',
        name: { zh: '电网高压并网', en: 'Grid High-Voltage' },
        upside: { zh: '防卫塔输出功率 +25%', en: 'Turret damage +25%' },
        downside: { zh: '电容回充周期 +15%', en: 'Capacitor cooldown +15%' },
        towerDamageMul: 1.25, towerIntervalMul: 1.15, enemySpeedMul: 1.0, rewardBonusCp: 0, startingGoldDelta: 0, baseHpDelta: 0,
      },
      {
        id: 'bounty_lure',
        name: { zh: '干道开放诱捕', en: 'Expressway Bait' },
        upside: { zh: '开局追加 +35 CP 应急预算', en: 'Immediate +35 CP budget' },
        downside: { zh: '失控车队车速 +15%', en: 'Convoy speed +15%' },
        towerDamageMul: 1.0, towerIntervalMul: 1.0, enemySpeedMul: 1.15, rewardBonusCp: 2, startingGoldDelta: 35, baseHpDelta: 0,
      },
      {
        id: 'fortify_grid',
        name: { zh: '中枢防火墙冗余', en: 'Firewall Redundancy' },
        upside: { zh: '中枢耐久 +6、响应提速 +10%', en: 'Hub HP +6, fire rate +10%' },
        downside: { zh: '开局预算扣减 -20 CP', en: 'Starting CP -20' },
        towerDamageMul: 1.0, towerIntervalMul: 0.9, enemySpeedMul: 1.0, rewardBonusCp: 0, startingGoldDelta: -20, baseHpDelta: 6,
      },
    ],
    affixTitle: { zh: '危机挑战词缀', en: 'Crisis Affixes' },
    affixes: [
      { id: 'emp_fog', name: { zh: '信号干扰雾', en: 'Signal Jamming' }, desc: { zh: '防卫塔雷达射程 -12%（评级 +1）', en: 'Radar range -12% (+1 Rank)' }, ratingBonus: 1, towerRangeMul: 0.88, enemySpeedMul: 1, enemyHpMul: 1 },
      { id: 'vanguard_surge', name: { zh: '超速飙车潮', en: 'Overdrive Surge' }, desc: { zh: '车队行驶速度 +18%（评级 +1）', en: 'Convoy speed +18% (+1 Rank)' }, ratingBonus: 1, towerRangeMul: 1, enemySpeedMul: 1.18, enemyHpMul: 1 },
      { id: 'armored_escort', name: { zh: '防暴重卡编队', en: 'Riot Convoy' }, desc: { zh: '车队装甲耐久 +22%（评级 +1）', en: 'Convoy HP +22% (+1 Rank)' }, ratingBonus: 1, towerRangeMul: 1, enemySpeedMul: 1, enemyHpMul: 1.22 },
    ],
    routeSplitLabel: { zh: '滨江大道主线 / 跨河高架匝道分流', en: 'Riverside Blvd / Overpass Ramp Split' },
    towers: {
      crossbow: { id: 'crossbow', legacyZh: '弩车', zh: '电磁拦阻桩', en: 'EMP Bollard', weaponZh: '脉冲电弧束', weaponEn: 'Pulse Arc', roleZh: '高频破盾', roleEn: 'Anti-Shield EMP', counterTrait: 'shield' },
      catapult: { id: 'catapult', legacyZh: '投石车', zh: '高能激光矩阵', en: 'Laser Array', weaponZh: '聚焦热熔激光', weaponEn: 'Thermal Lance', roleZh: '重型破甲', roleEn: 'Heavy Armor Melter', counterTrait: 'armor' },
      fire_brazier: { id: 'fire_brazier', legacyZh: '火油台', zh: '声波减速站', en: 'Sonic Suppressor', weaponZh: '定向声波震荡', weaponEn: 'Sonic Wave', roleZh: '压制快车', roleEn: 'Speed Suppressor', counterTrait: 'speed' },
      thorn: { id: 'thorn', legacyZh: '荆棘塔', zh: '电磁拦阻桩', en: 'EMP Bollard', weaponZh: '脉冲电弧束', weaponEn: 'Pulse Arc', roleZh: '高频破盾', roleEn: 'Anti-Shield EMP', counterTrait: 'shield' },
      poison: { id: 'poison', legacyZh: '毒雾塔', zh: '声波减速站', en: 'Sonic Suppressor', weaponZh: '定向声波震荡', weaponEn: 'Sonic Wave', roleZh: '压制快车', roleEn: 'Speed Suppressor', counterTrait: 'speed' },
      stone: { id: 'stone', legacyZh: '石像塔', zh: '高能激光矩阵', en: 'Laser Array', weaponZh: '聚焦热熔激光', weaponEn: 'Thermal Lance', roleZh: '重型破甲', roleEn: 'Heavy Armor Melter', counterTrait: 'armor' },
    },
    enemies: {
      footman: { id: 'footman', legacyZh: '步卒', zh: '磁盾巡检机器人', en: 'Mag-Shield Automaton', trait: 'shield', traitLabelZh: '磁力护盾', traitLabelEn: 'Mag Shield', counteredByZh: '电磁拦阻桩（电弧破盾 ×1.35）', counteredByEn: 'EMP Bollard (×1.35 vs Shield)' },
      light_cavalry: { id: 'light_cavalry', legacyZh: '轻骑', zh: '失控无人快车', en: 'Rogue Express Pod', trait: 'speed', traitLabelZh: '极速飙行', traitLabelEn: 'Overdrive', counteredByZh: '声波减速站（震荡截停 ×1.35）', counteredByEn: 'Sonic Suppressor (×1.35 vs Fast)' },
      heavy_armor: { id: 'heavy_armor', legacyZh: '重甲', zh: '重装装甲卡车', en: 'Armored Hauler', trait: 'armor', traitLabelZh: '复合重甲', traitLabelEn: 'Composite Armor', counteredByZh: '高能激光矩阵（热熔破甲 ×1.35）', counteredByEn: 'Laser Array (×1.35 vs Armor)' },
      bog_golem: { id: 'bog_golem', legacyZh: '泥沼巨人', zh: '全自动工程盾构车', en: 'Tunnel-Borer Rig', trait: 'armor', traitLabelZh: '合金盾构壳', traitLabelEn: 'Alloy Shielding', counteredByZh: '高能激光矩阵（热熔破甲 ×1.35）', counteredByEn: 'Laser Array (×1.35 vs Armor)' },
      swamp_frog: { id: 'swamp_frog', legacyZh: '沼泽蛙', zh: '磁悬浮疾行滑板', en: 'Mag-Lev Courier', trait: 'speed', traitLabelZh: '低空掠行', traitLabelEn: 'Low-Skim', counteredByZh: '声波减速站（震荡截停 ×1.35）', counteredByEn: 'Sonic Suppressor (×1.35 vs Fast)' },
      miasma_bug: { id: 'miasma_bug', legacyZh: '瘴气虫', zh: '微型脉冲巡飞弹', en: 'Micro-EMP Loiterer', trait: 'shield', traitLabelZh: '电离护膜', traitLabelEn: 'Ion Film', counteredByZh: '电磁拦阻桩（电弧破盾 ×1.35）', counteredByEn: 'EMP Bollard (×1.35 vs Shield)' },
    },
    presets: [
      { label: '滨江夜雨封控', prompt: '滨江夜雨，失控无人快车突袭' },
      { label: '跨河高架分流', prompt: '高架匝道分流，机器人集群涌入' },
      { label: '重装卡车攻坚', prompt: '重装装甲卡车压阵，高CP预算奖励' },
    ],
    placeholder: { zh: '输入调度预案构想，例如：滨江夜雨，失控无人快车突袭', en: 'Enter dispatch brief, e.g. Riverside rain, rogue express pods' },
    vfx: {
      projectileStyle: 'emp_arc',
      muzzleColor: '#b8fff6',
      beamCoreColor: '#e6ffff',
      beamGlowColor: '#2ea89c',
      shieldColor: '#48d1cc',
      critColor: '#ff784f',
      recoilPx: 4.0,
      hitStopMs: 38,
      screenShakePx: 3.6,
    },
  },
  'gothic-cathedral-3d': {
    skin: 'gothic-cathedral-3d',
    worldTitle: { zh: '暮钟圣堂 · 守夜教区', en: 'Vesper Cathedral Sanctuary' },
    councilTitle: { zh: '圣堂守夜审判庭', en: 'Vesper Vigil Tribunal' },
    advisorRole: { zh: '守夜大审判官', en: 'Grand Vigil Inquisitor' },
    advisorGlyph: { zh: '审', en: 'V' },
    baseTitle: { zh: '圣堂主座祭坛', en: 'High Cathedral Sanctum' },
    spawnTitle: { zh: '外环钟楼拱门', en: 'Outer Belfry Gate' },
    waveLabel: { zh: '夜潮警钟', en: 'Night Vesper Toll' },
    startAction: { zh: '敲响战钟', en: 'Toll Vesper Bell' },
    gambitTitle: { zh: '审判庭苦修誓约', en: 'Tribunal Penance Vow' },
    gambitNames: {
      swarm: { zh: '血月潮涌誓', en: 'Blood-Moon Tide', lineZh: '下波夜裔魔物数量 +50%', lineEn: 'Next wave: +50% nightspawn horde' },
      tight: { zh: '疾风狂猎誓', en: 'Wild Hunt Rush', lineZh: '下波魔物涌出间隔减半', lineEn: 'Next wave: 2x spawn frenzy' },
      tough: { zh: '黑曜石肤誓', en: 'Obsidian Hide', lineZh: '下波魔像躯壳生命 +40%', lineEn: 'Next wave: +40% gargoyle vitality' },
    },
    edictTitle: { zh: '战前参谋敕令（三选一）', en: 'Pre-Battle Tribunal Edict (Pick 1)' },
    edicts: [
      {
        id: 'overclock',
        name: { zh: '圣焰狂热祝圣', en: 'Sacred Flame Zeal' },
        upside: { zh: '圣堂钟楼净罪伤害 +25%', en: 'Sanctum damage +25%' },
        downside: { zh: '祷文咏唱间隔 +15%', en: 'Chant interval +15%' },
        towerDamageMul: 1.25, towerIntervalMul: 1.15, enemySpeedMul: 1.0, rewardBonusCp: 0, startingGoldDelta: 0, baseHpDelta: 0,
      },
      {
        id: 'bounty_lure',
        name: { zh: '圣物悬赏诱魔', en: 'Relic Lure Rite' },
        upside: { zh: '开局立得 +35 CP 恩典圣契', en: 'Immediate +35 CP grace' },
        downside: { zh: '夜裔疾行速度 +15%', en: 'Nightspawn speed +15%' },
        towerDamageMul: 1.0, towerIntervalMul: 1.0, enemySpeedMul: 1.15, rewardBonusCp: 2, startingGoldDelta: 35, baseHpDelta: 0,
      },
      {
        id: 'fortify_grid',
        name: { zh: '圣咏护教结界', en: 'Choir Aegis Ward' },
        upside: { zh: '主座圣盾 +6、咏唱提速 +10%', en: 'Sanctum HP +6, fire rate +10%' },
        downside: { zh: '开局圣契消耗 -20 CP', en: 'Starting CP -20' },
        towerDamageMul: 1.0, towerIntervalMul: 0.9, enemySpeedMul: 1.0, rewardBonusCp: 0, startingGoldDelta: -20, baseHpDelta: 6,
      },
    ],
    affixTitle: { zh: '危机挑战词缀', en: 'Crisis Affixes' },
    affixes: [
      { id: 'emp_fog', name: { zh: '永夜浓雾', en: 'Abyssal Mist' }, desc: { zh: '圣光钟楼照亮射程 -12%（评级 +1）', en: 'Sanctum range -12% (+1 Rank)' }, ratingBonus: 1, towerRangeMul: 0.88, enemySpeedMul: 1, enemyHpMul: 1 },
      { id: 'vanguard_surge', name: { zh: '狂猎夜袭', en: 'Blood-Moon Frenzy' }, desc: { zh: '夜裔奔袭速度 +18%（评级 +1）', en: 'Nightspawn speed +18% (+1 Rank)' }, ratingBonus: 1, towerRangeMul: 1, enemySpeedMul: 1.18, enemyHpMul: 1 },
      { id: 'armored_escort', name: { zh: '黑曜石魔像群', en: 'Obsidian Gargoyles' }, desc: { zh: '魔物躯壳耐久 +22%（评级 +1）', en: 'Nightspawn HP +22% (+1 Rank)' }, ratingBonus: 1, towerRangeMul: 1, enemySpeedMul: 1, enemyHpMul: 1.22 },
    ],
    routeSplitLabel: { zh: '圣堂主甬道 / 回廊飞扶壁支线分流', en: 'Nave Processional / Flying-Buttress Split' },
    towers: {
      crossbow: { id: 'crossbow', legacyZh: '弩车', zh: '圣光钟楼', en: 'Sunlit Belfry', weaponZh: '辉光裁决枪', weaponEn: 'Radiant Lance', roleZh: '高频破障', roleEn: 'Ward Breaker', counterTrait: 'shield' },
      catapult: { id: 'catapult', legacyZh: '投石车', zh: '净罪重弩炮', en: 'Purging Ballista', weaponZh: '银铸破魔巨矢', weaponEn: 'Silver Siege Bolt', roleZh: '重型碎岩', roleEn: 'Gargoyle Shatterer', counterTrait: 'armor' },
      fire_brazier: { id: 'fire_brazier', legacyZh: '火油台', zh: '唱诗共鸣碑', en: 'Choir Resonance Stele', weaponZh: '圣咏镇魂波', weaponEn: 'Hymn Shockwave', roleZh: '压制影狼', roleEn: 'Stalker Suppressor', counterTrait: 'speed' },
      thorn: { id: 'thorn', legacyZh: '荆棘塔', zh: '圣光钟楼', en: 'Sunlit Belfry', weaponZh: '辉光裁决枪', weaponEn: 'Radiant Lance', roleZh: '高频破障', roleEn: 'Ward Breaker', counterTrait: 'shield' },
      poison: { id: 'poison', legacyZh: '毒雾塔', zh: '唱诗共鸣碑', en: 'Choir Resonance Stele', weaponZh: '圣咏镇魂波', weaponEn: 'Hymn Shockwave', roleZh: '压制影狼', roleEn: 'Stalker Suppressor', counterTrait: 'speed' },
      stone: { id: 'stone', legacyZh: '石像塔', zh: '净罪重弩炮', en: 'Purging Ballista', weaponZh: '银铸破魔巨矢', weaponEn: 'Silver Siege Bolt', roleZh: '重型碎岩', roleEn: 'Gargoyle Shatterer', counterTrait: 'armor' },
    },
    enemies: {
      footman: { id: 'footman', legacyZh: '步卒', zh: '黯影障壁食尸鬼', en: 'Umbral-Ward Ghoul', trait: 'shield', traitLabelZh: '黯影障壁', traitLabelEn: 'Umbral Ward', counteredByZh: '圣光钟楼（辉光破障 ×1.35）', counteredByEn: 'Sunlit Belfry (×1.35 vs Ward)' },
      light_cavalry: { id: 'light_cavalry', legacyZh: '轻骑', zh: '血月疾行夜魔', en: 'Blood-Moon Stalker', trait: 'speed', traitLabelZh: '疾影突袭', traitLabelEn: 'Shadow Sprint', counteredByZh: '唱诗共鸣碑（圣咏镇魂 ×1.35）', counteredByEn: 'Choir Stele (×1.35 vs Fast)' },
      heavy_armor: { id: 'heavy_armor', legacyZh: '重甲', zh: '黑曜石像魔像', en: 'Obsidian Gargoyle', trait: 'armor', traitLabelZh: '黑曜石甲', traitLabelEn: 'Obsidian Carapace', counteredByZh: '净罪重弩炮（破魔碎岩 ×1.35）', counteredByEn: 'Purging Ballista (×1.35 vs Armor)' },
      bog_golem: { id: 'bog_golem', legacyZh: '泥沼巨人', zh: '赎罪青铜巨像', en: 'Penitent Bronze Colossus', trait: 'armor', traitLabelZh: '古圣青铜甲', traitLabelEn: 'Sanctified Bronze', counteredByZh: '净罪重弩炮（破魔碎岩 ×1.35）', counteredByEn: 'Purging Ballista (×1.35 vs Armor)' },
      swamp_frog: { id: 'swamp_frog', legacyZh: '沼泽蛙', zh: '尖塔夜翼石像鬼', en: 'Spire Night-Gargoyle', trait: 'speed', traitLabelZh: '俯冲猎袭', traitLabelEn: 'Dive Pounce', counteredByZh: '唱诗共鸣碑（圣咏镇魂 ×1.35）', counteredByEn: 'Choir Stele (×1.35 vs Fast)' },
      miasma_bug: { id: 'miasma_bug', legacyZh: '瘴气虫', zh: '冥火渡鸦魔群', en: 'Bale-Fire Raven Flock', trait: 'shield', traitLabelZh: '冥火障纱', traitLabelEn: 'Bale Shroud', counteredByZh: '圣光钟楼（辉光破障 ×1.35）', counteredByEn: 'Sunlit Belfry (×1.35 vs Ward)' },
    },
    presets: [
      { label: '暮钟血月守夜', prompt: '暮钟血月夜，疾行夜魔突袭' },
      { label: '回廊双路伏击', prompt: '飞扶壁回廊分流，食尸鬼潮涌' },
      { label: '黑曜石魔像攻城', prompt: '黑曜石像魔像压阵，高CP圣契奖励' },
    ],
    placeholder: { zh: '输入守夜审判构想，例如：暮钟血月夜，疾行夜魔突袭', en: 'Enter vigil brief, e.g. Blood-moon night, shadow stalker raid' },
    vfx: {
      projectileStyle: 'holy_lance',
      muzzleColor: '#fff5d6',
      beamCoreColor: '#fff9e6',
      beamGlowColor: '#e4c596',
      shieldColor: '#b39ddb',
      critColor: '#ffd54f',
      recoilPx: 5.0,
      hitStopMs: 46,
      screenShakePx: 4.5,
    },
  },
  'harbor-district-3d': {
    skin: 'harbor-district-3d',
    worldTitle: { zh: '潮汐港湾 · 海事防区', en: 'Tidal Harbor District' },
    councilTitle: { zh: '港务海事防卫局', en: 'Harbor Maritime Command' },
    advisorRole: { zh: '海事防卫总领航员', en: 'Chief Harbor Navigator' },
    advisorGlyph: { zh: '航', en: 'H' },
    baseTitle: { zh: '海事总署灯塔', en: 'Admiralty Lighthouse' },
    spawnTitle: { zh: '外港引航栈桥', en: 'Outer Pier Approach' },
    waveLabel: { zh: '风暴潮次', en: 'Tidal Surge' },
    startAction: { zh: '拉响海防警报', en: 'Sound Sea-Watch' },
    gambitTitle: { zh: '海事防务特许令', en: 'Maritime Charter' },
    gambitNames: {
      swarm: { zh: '大潮开闸令', en: 'Floodgate Open', lineZh: '下波闯关船队数量 +50%', lineEn: 'Next wave: +50% raiders' },
      tight: { zh: '顺风急流令', en: 'Riptide Rush', lineZh: '下波快艇出航间隔减半', lineEn: 'Next wave: 2x launch cadence' },
      tough: { zh: '重装钢壳令', en: 'Ironclad Hulls', lineZh: '下波破冰船装甲 +40%', lineEn: 'Next wave: +40% hull armor' },
    },
    edictTitle: { zh: '战前参谋敕令（三选一）', en: 'Pre-Battle Maritime Edict (Pick 1)' },
    edicts: [
      {
        id: 'overclock',
        name: { zh: '穿甲高爆装药', en: 'AP-HE Shell Load' },
        upside: { zh: '岸防炮台伤害 +25%', en: 'Battery damage +25%' },
        downside: { zh: '装填冷却间隔 +15%', en: 'Reload interval +15%' },
        towerDamageMul: 1.25, towerIntervalMul: 1.15, enemySpeedMul: 1.0, rewardBonusCp: 0, startingGoldDelta: 0, baseHpDelta: 0,
      },
      {
        id: 'bounty_lure',
        name: { zh: '自由港诱捕航道', en: 'Free-Port Lure' },
        upside: { zh: '开局立得 +35 CP 港务补贴', en: 'Immediate +35 CP grant' },
        downside: { zh: '走私快艇航速 +15%', en: 'Smuggler speed +15%' },
        towerDamageMul: 1.0, towerIntervalMul: 1.0, enemySpeedMul: 1.15, rewardBonusCp: 2, startingGoldDelta: 35, baseHpDelta: 0,
      },
      {
        id: 'fortify_grid',
        name: { zh: '防波堤消波加固', en: 'Breakwater Bulwark' },
        upside: { zh: '灯塔耐久 +6、射速 +10%', en: 'Lighthouse HP +6, fire rate +10%' },
        downside: { zh: '开局工程耗资 -20 CP', en: 'Starting CP -20' },
        towerDamageMul: 1.0, towerIntervalMul: 0.9, enemySpeedMul: 1.0, rewardBonusCp: 0, startingGoldDelta: -20, baseHpDelta: 6,
      },
    ],
    affixTitle: { zh: '危机挑战词缀', en: 'Crisis Affixes' },
    affixes: [
      { id: 'emp_fog', name: { zh: '海雾锁港', en: 'Dense Sea Fog' }, desc: { zh: '岸防雷达索敌射程 -12%（评级 +1）', en: 'Battery range -12% (+1 Rank)' }, ratingBonus: 1, towerRangeMul: 0.88, enemySpeedMul: 1, enemyHpMul: 1 },
      { id: 'vanguard_surge', name: { zh: '急流走私潮', en: 'Riptide Blitz' }, desc: { zh: '敌船冲滩航速 +18%（评级 +1）', en: 'Vessel speed +18% (+1 Rank)' }, ratingBonus: 1, towerRangeMul: 1, enemySpeedMul: 1.18, enemyHpMul: 1 },
      { id: 'armored_escort', name: { zh: '破冰铁甲船团', en: 'Icebreaker Armada' }, desc: { zh: '敌船钢壳耐久 +22%（评级 +1）', en: 'Hull HP +22% (+1 Rank)' }, ratingBonus: 1, towerRangeMul: 1, enemySpeedMul: 1, enemyHpMul: 1.22 },
    ],
    routeSplitLabel: { zh: '主航道深水泊位 / 栈桥引水渠分流', en: 'Main Channel / Pier Canal Split' },
    towers: {
      crossbow: { id: 'crossbow', legacyZh: '弩车', zh: '防波堤速射炮', en: 'Breakwater Autocannon', weaponZh: '双联穿甲机炮', weaponEn: 'Twin Autocannon', roleZh: '高频破障', roleEn: 'Barrier Breaker', counterTrait: 'shield' },
      catapult: { id: 'catapult', legacyZh: '投石车', zh: '岸防重型榴弹炮', en: 'Coastal Howitzer', weaponZh: '大口径破甲榴弹', weaponEn: 'Heavy Siege Shell', roleZh: '重型破甲', roleEn: 'Icebreaker Buster', counterTrait: 'armor' },
      fire_brazier: { id: 'fire_brazier', legacyZh: '火油台', zh: '声呐水雷信标', en: 'Sonar Mine Beacon', weaponZh: '声呐震波水雷', weaponEn: 'Sonar Shock Pulse', roleZh: '压制快艇', roleEn: 'Speedboat Suppressor', counterTrait: 'speed' },
      thorn: { id: 'thorn', legacyZh: '荆棘塔', zh: '防波堤速射炮', en: 'Breakwater Autocannon', weaponZh: '双联穿甲机炮', weaponEn: 'Twin Autocannon', roleZh: '高频破障', roleEn: 'Barrier Breaker', counterTrait: 'shield' },
      poison: { id: 'poison', legacyZh: '毒雾塔', zh: '声呐水雷信标', en: 'Sonar Mine Beacon', weaponZh: '声呐震波水雷', weaponEn: 'Sonar Shock Pulse', roleZh: '压制快艇', roleEn: 'Speedboat Suppressor', counterTrait: 'speed' },
      stone: { id: 'stone', legacyZh: '石像塔', zh: '岸防重型榴弹炮', en: 'Coastal Howitzer', weaponZh: '大口径破甲榴弹', weaponEn: 'Heavy Siege Shell', roleZh: '重型破甲', roleEn: 'Icebreaker Buster', counterTrait: 'armor' },
    },
    enemies: {
      footman: { id: 'footman', legacyZh: '步卒', zh: '气垫护盾驳船', en: 'Cushion-Shield Barge', trait: 'shield', traitLabelZh: '气垫偏导盾', traitLabelEn: 'Deflector Cushion', counteredByZh: '防波堤速射炮（速射破盾 ×1.35）', counteredByEn: 'Autocannon (×1.35 vs Shield)' },
      light_cavalry: { id: 'light_cavalry', legacyZh: '轻骑', zh: '涡轮走私快艇', en: 'Turbo Smuggler Skiff', trait: 'speed', traitLabelZh: '涡轮冲滩', traitLabelEn: 'Turbo Foil', counteredByZh: '声呐水雷信标（震波截击 ×1.35）', counteredByEn: 'Sonar Beacon (×1.35 vs Fast)' },
      heavy_armor: { id: 'heavy_armor', legacyZh: '重甲', zh: '重装破冰装甲舰', en: 'Armored Icebreaker', trait: 'armor', traitLabelZh: '破冰钢壳', traitLabelEn: 'Icebreaker Hull', counteredByZh: '岸防重型榴弹炮（榴弹破甲 ×1.35）', counteredByEn: 'Coastal Howitzer (×1.35 vs Armor)' },
      bog_golem: { id: 'bog_golem', legacyZh: '泥沼巨人', zh: '深海重型潜航器', en: 'Abyssal Submersible', trait: 'armor', traitLabelZh: '耐压钛合金壳', traitLabelEn: 'Titanium Pressure Hull', counteredByZh: '岸防重型榴弹炮（榴弹破甲 ×1.35）', counteredByEn: 'Coastal Howitzer (×1.35 vs Armor)' },
      swamp_frog: { id: 'swamp_frog', legacyZh: '沼泽蛙', zh: '飞鱼水翼突击艇', en: 'Hydrofoil Raider', trait: 'speed', traitLabelZh: '水翼掠浪', traitLabelEn: 'Hydrofoil Skim', counteredByZh: '声呐水雷信标（震波截击 ×1.35）', counteredByEn: 'Sonar Beacon (×1.35 vs Fast)' },
      miasma_bug: { id: 'miasma_bug', legacyZh: '瘴气虫', zh: '漂流感应水雷群', en: 'Drifting Mine Cluster', trait: 'shield', traitLabelZh: '磁感偏导壳', traitLabelEn: 'Magnetic Shell', counteredByZh: '防波堤速射炮（速射破盾 ×1.35）', counteredByEn: 'Autocannon (×1.35 vs Shield)' },
    },
    presets: [
      { label: '风暴潮夜航拦截', prompt: '海港风暴潮，涡轮走私快艇突袭' },
      { label: '深水航道分流', prompt: '栈桥航道分流，气垫驳船集群闯关' },
      { label: '重装破冰舰攻坚', prompt: '重装破冰装甲舰压阵，高CP补贴奖励' },
    ],
    placeholder: { zh: '输入海事布防构想，例如：海港风暴潮，涡轮走私快艇突袭', en: 'Enter maritime brief, e.g. Harbor storm surge, turbo skiff raid' },
    vfx: {
      projectileStyle: 'naval_shell',
      muzzleColor: '#ffe0b2',
      beamCoreColor: '#fff3e0',
      beamGlowColor: '#256e7c',
      shieldColor: '#4dd0e1',
      critColor: '#ff7043',
      recoilPx: 5.2,
      hitStopMs: 45,
      screenShakePx: 4.8,
    },
  },
};

export function resolveSkinId(skin?: string | null): SkinId {
  if (skin && skin in SKIN_CULTURAL_LEXICONS) return skin as SkinId;
  return 'union-atlas-3d';
}

export function getCulturalLexicon(skin?: string | null): SkinCulturalLexicon {
  return SKIN_CULTURAL_LEXICONS[resolveSkinId(skin)];
}

/** 获取防御塔在当前皮肤与语言下的文化显示名 */
export function culturalTowerName(towerId: string, fallbackName: string, skin?: string | null, lang: 'zh' | 'en' = 'zh'): string {
  const lex = getCulturalLexicon(skin);
  const spec = lex.towers[towerId];
  if (spec) return lang === 'zh' ? spec.zh : spec.en;
  return replaceAncientTerms(fallbackName, skin, lang);
}

/** 获取敌军在当前皮肤与语言下的文化显示名 */
export function culturalEnemyName(enemyId: string, fallbackName: string, skin?: string | null, lang: 'zh' | 'en' = 'zh'): string {
  const lex = getCulturalLexicon(skin);
  const spec = lex.enemies[enemyId];
  if (spec) return lang === 'zh' ? spec.zh : spec.en;
  return replaceAncientTerms(fallbackName, skin, lang);
}

/** 将一段自由文本中的古代中国称谓替换为当前皮肤世界观称谓 */
export function replaceAncientTerms(text: string, skin?: string | null, lang: 'zh' | 'en' = 'zh'): string {
  if (!text) return '';
  const lex = getCulturalLexicon(skin);
  if (lang === 'en') return text;
  let out = text
    .replace(/军师议事/g, lex.councilTitle.zh)
    .replace(/本地模板军师/g, lex.advisorRole.zh)
    .replace(/频道智能体军师/g, lex.advisorRole.zh)
    .replace(/沙盘参谋/g, lex.advisorRole.zh)
    .replace(/长坂坡·雨夜（灰盒）/g, lex.worldTitle.zh)
    .replace(/长坂坡·雨夜/g, lex.worldTitle.zh)
    .replace(/长坂坡雨夜/g, lex.presets[0]?.label ?? lex.worldTitle.zh)
    .replace(/沼泽·毒雾/g, `${lex.worldTitle.zh}·高危区`)
    .replace(/弩车|神臂弩|连弩/g, lex.towers.crossbow.zh)
    .replace(/投石车|霹雳车/g, lex.towers.catapult.zh)
    .replace(/火油台|猛火油柜/g, lex.towers.fire_brazier.zh)
    .replace(/荆棘塔/g, lex.towers.thorn.zh)
    .replace(/毒雾塔/g, lex.towers.poison.zh)
    .replace(/石像塔/g, lex.towers.stone.zh)
    .replace(/步卒|刀盾步卒/g, lex.enemies.footman.zh)
    .replace(/轻骑|虎豹骑|游骑/g, lex.enemies.light_cavalry.zh)
    .replace(/重甲|铁浮屠|重盾甲士/g, lex.enemies.heavy_armor.zh)
    .replace(/泥沼巨人/g, lex.enemies.bog_golem.zh)
    .replace(/沼泽蛙/g, lex.enemies.swamp_frog.zh)
    .replace(/瘴气虫/g, lex.enemies.miasma_bug.zh);
  return out;
}

/** 将内容包（ContentPack）的塔、敌军、主题名按当前皮肤做文化映射与参谋敕令/词缀调制，并补齐多分支并行进军路径 */
export function localizePackForSkin(
  basePack: ContentPack,
  skin?: string | null,
  lang: 'zh' | 'en' = 'zh',
  edictId?: EdictOptionSpec['id'] | null,
  activeAffixes: CrisisAffixSpec['id'][] = [],
): ContentPack {
  const lex = getCulturalLexicon(skin);
  const edict = edictId ? lex.edicts.find((e) => e.id === edictId) ?? null : null;
  const affixSpecs = activeAffixes
    .map((id) => lex.affixes.find((a) => a.id === id))
    .filter((a): a is CrisisAffixSpec => !!a);

  const dmgMul = edict?.towerDamageMul ?? 1;
  const intMul = edict?.towerIntervalMul ?? 1;
  const rangeMul = affixSpecs.reduce((acc, a) => acc * a.towerRangeMul, 1);
  const spdMul = (edict?.enemySpeedMul ?? 1) * affixSpecs.reduce((acc, a) => acc * a.enemySpeedMul, 1);
  const hpMul = affixSpecs.reduce((acc, a) => acc * a.enemyHpMul, 1);
  const rewardBonus = edict?.rewardBonusCp ?? 0;

  // 若 basePack 尚未含多分支路线，基于主路径自动派生一条从第 2 折点分叉、在终点前汇合的侧翼并行进军路线
  let branchPaths = basePack.map.branch_paths;
  if ((!branchPaths || !branchPaths.length) && basePack.map.path.length >= 4) {
    const H = basePack.map.height;
    const p = basePack.map.path;
    const start = p[0];
    const end = p[p.length - 1];
    const preEnd = p[p.length - 2];
    const altY = start.y < H / 2 ? Math.min(H - 2, start.y + 4) : Math.max(1, start.y - 4);
    const midX = Math.max(2, Math.min(basePack.map.width - 3, Math.floor(basePack.map.width * 0.55)));
    branchPaths = [
      [
        { x: start.x, y: altY },
        { x: midX, y: altY },
        { x: midX, y: preEnd.y },
        { x: preEnd.x, y: preEnd.y },
        { x: end.x, y: end.y },
      ],
    ];
  }

  return {
    ...basePack,
    meta: {
      theme: lang === 'zh' ? lex.worldTitle.zh : lex.worldTitle.en,
      description: replaceAncientTerms(basePack.meta.description, skin, lang),
    },
    towers: basePack.towers.map((t) => ({
      ...t,
      display_name: culturalTowerName(t.id, t.display_name, skin, lang),
      damage: Math.max(1, Math.round(t.damage * dmgMul)),
      interval_ticks: Math.max(4, Math.round(t.interval_ticks * intMul)),
      range: Math.max(1000, Math.round(t.range * rangeMul)),
    })),
    enemies: basePack.enemies.map((e) => ({
      ...e,
      display_name: culturalEnemyName(e.id, e.display_name, skin, lang),
      hp: Math.max(10, Math.round(e.hp * hpMul)),
      speed: Math.max(15, Math.round(e.speed * spdMul)),
      reward: Math.max(1, e.reward + rewardBonus),
    })),
    map: {
      ...basePack.map,
      ...(branchPaths ? { branch_paths: branchPaths } : {}),
      base_hp: Math.max(5, basePack.map.base_hp + (edict?.baseHpDelta ?? 0)),
      starting_gold: Math.max(60, basePack.map.starting_gold + (edict?.startingGoldDelta ?? 0)),
    },
  };
}

/** 计算防御塔对特定敌军的兵种克制伤害倍率与克制标签 */
export function computeCounterPreview(
  towerId: string,
  enemyId: string,
  skin?: string | null,
): { multiplier: number; isCounter: boolean; isResisted: boolean; tagZh: string; tagEn: string } {
  const lex = getCulturalLexicon(skin);
  const tw = lex.towers[towerId] ?? lex.towers.crossbow;
  const en = lex.enemies[enemyId] ?? lex.enemies.footman;
  if (tw.counterTrait === en.trait) {
    const tagZh = en.trait === 'shield' ? '破盾暴击' : en.trait === 'armor' ? '穿甲重击' : '截击压制';
    const tagEn = en.trait === 'shield' ? 'SHIELD BREAK' : en.trait === 'armor' ? 'ARMOR PIERCE' : 'INTERCEPT';
    return { multiplier: 1.35, isCounter: true, isResisted: false, tagZh, tagEn };
  }
  if (
    (tw.counterTrait === 'shield' && en.trait === 'armor') ||
    (tw.counterTrait === 'armor' && en.trait === 'speed')
  ) {
    return { multiplier: 0.8, isCounter: false, isResisted: true, tagZh: '护甲偏转', tagEn: 'DEFLECTED' };
  }
  return { multiplier: 1.0, isCounter: false, isResisted: false, tagZh: '命中', tagEn: 'HIT' };
}

/** 生成新旧名对照表结构化数据（供自检与文档校验） */
export function buildCulturalMappingTable() {
  return (Object.keys(SKIN_CULTURAL_LEXICONS) as SkinId[]).map((skinId) => {
    const lex = SKIN_CULTURAL_LEXICONS[skinId];
    return {
      skin: skinId,
      worldTitle: lex.worldTitle.zh,
      councilTitle: { legacy: '军师议事', current: lex.councilTitle.zh },
      advisorRole: { legacy: '军师 / 沙盘参谋', current: lex.advisorRole.zh },
      baseBuilding: { legacy: '基地 / 城池', current: lex.baseTitle.zh },
      spawnBuilding: { legacy: '出兵口 / 敌营', current: lex.spawnTitle.zh },
      gambitTitle: { legacy: '奇策（人海/急行军/铁甲）', current: `${lex.gambitTitle.zh}（${lex.gambitNames.swarm.zh}/${lex.gambitNames.tight.zh}/${lex.gambitNames.tough.zh}）` },
      towers: [
        { id: 'crossbow', legacy: '弩车', current: lex.towers.crossbow.zh, weapon: lex.towers.crossbow.weaponZh, role: lex.towers.crossbow.roleZh },
        { id: 'catapult', legacy: '投石车', current: lex.towers.catapult.zh, weapon: lex.towers.catapult.weaponZh, role: lex.towers.catapult.roleZh },
        { id: 'fire_brazier', legacy: '火油台', current: lex.towers.fire_brazier.zh, weapon: lex.towers.fire_brazier.weaponZh, role: lex.towers.fire_brazier.roleZh },
      ],
      enemies: [
        { id: 'footman', legacy: '步卒', current: lex.enemies.footman.zh, trait: lex.enemies.footman.traitLabelZh, counter: lex.enemies.footman.counteredByZh },
        { id: 'light_cavalry', legacy: '轻骑', current: lex.enemies.light_cavalry.zh, trait: lex.enemies.light_cavalry.traitLabelZh, counter: lex.enemies.light_cavalry.counteredByZh },
        { id: 'heavy_armor', legacy: '重甲', current: lex.enemies.heavy_armor.zh, trait: lex.enemies.heavy_armor.traitLabelZh, counter: lex.enemies.heavy_armor.counteredByZh },
        { id: 'bog_golem', legacy: '泥沼巨人', current: lex.enemies.bog_golem.zh, trait: lex.enemies.bog_golem.traitLabelZh, counter: lex.enemies.bog_golem.counteredByZh },
        { id: 'swamp_frog', legacy: '沼泽蛙', current: lex.enemies.swamp_frog.zh, trait: lex.enemies.swamp_frog.traitLabelZh, counter: lex.enemies.swamp_frog.counteredByZh },
        { id: 'miasma_bug', legacy: '瘴气虫', current: lex.enemies.miasma_bug.zh, trait: lex.enemies.miasma_bug.traitLabelZh, counter: lex.enemies.miasma_bug.counteredByZh },
      ],
    };
  });
}

export const CAMPAIGN_MAX_LEVEL = 1000;
export const CAMPAIGN_SKIN_ROTATION: readonly SkinId[] = [
  'union-atlas-3d',
  'metropolis-riverside-3d',
  'gothic-cathedral-3d',
  'harbor-district-3d',
];

/** 1000 关递增战役的长路径模板池（14×10 棋盘，8–10 个折点，总长 26–34 格，比初始 22 格更长且无自交） */
const CAMPAIGN_PATH_TEMPLATES: readonly { x: number; y: number }[][] = [
  [
    { x: 0, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 4 }, { x: 1, y: 4 },
    { x: 1, y: 7 }, { x: 7, y: 7 }, { x: 7, y: 2 }, { x: 11, y: 2 },
    { x: 11, y: 8 }, { x: 13, y: 8 },
  ],
  [
    { x: 0, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 6 }, { x: 2, y: 6 },
    { x: 2, y: 8 }, { x: 9, y: 8 }, { x: 9, y: 3 }, { x: 12, y: 3 },
    { x: 12, y: 7 }, { x: 13, y: 7 },
  ],
  [
    { x: 0, y: 7 }, { x: 3, y: 7 }, { x: 3, y: 2 }, { x: 7, y: 2 },
    { x: 7, y: 6 }, { x: 10, y: 6 }, { x: 10, y: 1 }, { x: 12, y: 1 },
    { x: 12, y: 8 }, { x: 13, y: 8 },
  ],
  [
    { x: 0, y: 4 }, { x: 3, y: 4 }, { x: 3, y: 1 }, { x: 8, y: 1 },
    { x: 8, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 8 }, { x: 11, y: 8 },
    { x: 11, y: 4 }, { x: 13, y: 4 },
  ],
];

function expandCellsSet(path: { x: number; y: number }[]): Set<string> {
  const out = new Set<string>();
  if (!path.length) return out;
  out.add(`${path[0].x},${path[0].y}`);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
    let x = a.x, y = a.y;
    while (x !== b.x || y !== b.y) {
      x += dx;
      y += dy;
      out.add(`${x},${y}`);
    }
  }
  return out;
}

/**
 * 生成第 `level` 关（`1 .. 1000`）的战役关卡内容包（大厅 #26188 ⑥⑦⑧）：
 * - 包含 6 种差异化兵种（护盾巡逻、高速快车、重装主战、微型集群、跃迁飞梭、重型巨像）与 3 座克制塔；
 * - 严格限制 `base_damage` 上限为 `1..3`（快车/轻型单位 `base_damage = 1`，重甲 `2`，巨像 `3`），快车移速校准为 `52`，彻底根治「打完第一辆小车就没了」；
 * - 随关卡号 `1 → 1000` 温和递增波次数（`3 → 8` 波）、兵种组合复杂度与敌军耐久，同时保证前 3 关及后续关卡在合理折角布防下稳健可赢、不合理布防会失败。
 */
export function generateCampaignPack(
  level: number,
  skin?: string | null,
  lang: 'zh' | 'en' = 'zh',
  edictId?: EdictOptionSpec['id'] | null,
  activeAffixes: CrisisAffixSpec['id'][] = [],
): ContentPack {
  const lv = Math.max(1, Math.min(CAMPAIGN_MAX_LEVEL, Math.round(level || 1)));
  const resolvedSkin = skin ? resolveSkinId(skin) : CAMPAIGN_SKIN_ROTATION[(lv - 1) % CAMPAIGN_SKIN_ROTATION.length];
  const lex = getCulturalLexicon(resolvedSkin);
  const W = 14, H = 10;
  const tpl = CAMPAIGN_PATH_TEMPLATES[(lv - 1) % CAMPAIGN_PATH_TEMPLATES.length];
  const flipY = Math.floor((lv - 1) / CAMPAIGN_PATH_TEMPLATES.length) % 2 === 1;
  const path = tpl.map((c) => ({ x: c.x, y: flipY ? H - 1 - c.y : c.y }));
  const onPath = expandCellsSet(path);
  const buildable_cells: { x: number; y: number }[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!onPath.has(`${x},${y}`)) buildable_cells.push({ x, y });
    }
  }

  // 难度曲线：第 1 关 1.00x，第 2 关 1.08x，第 3 关 1.16x，至 1000 关平滑对数递增，同时同步提升开局与击杀 CP
  const prog = (lv - 1) / (CAMPAIGN_MAX_LEVEL - 1);
  const hpScale = 1 + Math.min(0.32, (lv - 1) * 0.08) + Math.pow(prog, 0.72) * 2.4;
  const spdScale = 1 + Math.min(0.18, prog * 0.18);
  const waveCount = Math.min(8, 3 + Math.floor(Math.log2(lv + 1)));
  const startingGold = Math.min(420, 180 + Math.floor((lv - 1) * 6));

  const basePack: ContentPack = {
    meta: {
      theme: lang === 'zh'
        ? `${lex.worldTitle.zh} · 第 ${lv}/${CAMPAIGN_MAX_LEVEL} 关`
        : `${lex.worldTitle.en} · Stage ${lv}/${CAMPAIGN_MAX_LEVEL}`,
      description: lang === 'zh'
        ? `第 ${lv} 关战役防线：6 兵种协同突袭，终点死守母星方碑（${lex.baseTitle.zh}）`
        : `Stage ${lv}/${CAMPAIGN_MAX_LEVEL}: 6 enemy classes advancing on ${lex.baseTitle.en}`,
    },
    towers: [
      { id: 'crossbow', display_name: lex.towers.crossbow[lang], cost: 60, damage: 20, range: 2650, interval_ticks: 18, color: '#6FB1FF' },
      { id: 'fire_brazier', display_name: lex.towers.fire_brazier[lang], cost: 80, damage: 12, range: 2250, interval_ticks: 10, color: '#4DD0E1' },
      { id: 'catapult', display_name: lex.towers.catapult[lang], cost: 110, damage: 48, range: 3500, interval_ticks: 52, color: '#E8C170' },
    ],
    enemies: [
      { id: 'footman', display_name: lex.enemies.footman[lang], hp: Math.round(105 * hpScale), speed: Math.round(35 * spdScale), base_damage: 1, reward: 14, color: '#C84B4B' },
      { id: 'light_cavalry', display_name: lex.enemies.light_cavalry[lang], hp: Math.round(64 * hpScale), speed: Math.min(68, Math.round(52 * spdScale)), base_damage: 1, reward: 12, color: '#FF8A65' },
      { id: 'heavy_armor', display_name: lex.enemies.heavy_armor[lang], hp: Math.round(280 * hpScale), speed: Math.round(24 * spdScale), base_damage: 2, reward: 28, color: '#90A4AE' },
      { id: 'miasma_bug', display_name: lex.enemies.miasma_bug[lang], hp: Math.round(42 * hpScale), speed: Math.round(44 * spdScale), base_damage: 1, reward: 6, color: '#BA68C8' },
      { id: 'swamp_frog', display_name: lex.enemies.swamp_frog[lang], hp: Math.round(78 * hpScale), speed: Math.min(64, Math.round(48 * spdScale)), base_damage: 1, reward: 11, color: '#4DB6AC' },
      { id: 'bog_golem', display_name: lex.enemies.bog_golem[lang], hp: Math.round(360 * hpScale), speed: Math.round(20 * spdScale), base_damage: 3, reward: 35, color: '#7986CB' },
    ],
    map: {
      width: W,
      height: H,
      path,
      buildable_cells,
      base_hp: 20,
      starting_gold: startingGold,
    },
    waves: Array.from({ length: waveCount }, (_, wi) => {
      const groups: { enemy_id: string; count: number; interval_ticks: number }[] = [];
      const extra = Math.min(8, Math.floor((lv - 1) / 4));
      if (wi === 0) {
        groups.push({ enemy_id: 'footman', count: 5 + Math.min(4, extra), interval_ticks: 28 });
        groups.push({ enemy_id: 'miasma_bug', count: 4 + Math.min(4, extra), interval_ticks: 22 });
      } else if (wi === 1) {
        groups.push({ enemy_id: 'footman', count: 5 + Math.min(5, extra), interval_ticks: 25 });
        groups.push({ enemy_id: 'light_cavalry', count: 4 + Math.min(4, extra), interval_ticks: 24 });
        groups.push({ enemy_id: 'swamp_frog', count: 3 + Math.min(3, extra), interval_ticks: 24 });
      } else {
        groups.push({ enemy_id: 'heavy_armor', count: 2 + Math.min(3, Math.floor(wi / 2)), interval_ticks: 45 });
        groups.push({ enemy_id: 'light_cavalry', count: 4 + Math.min(4, extra), interval_ticks: 22 });
        if (wi >= 2 || lv >= 2) {
          groups.push({ enemy_id: 'bog_golem', count: 1 + Math.min(2, Math.floor((lv + wi) / 4)), interval_ticks: 55 });
        }
      }
      return { id: `w${wi + 1}`, groups };
    }),
  };

  return localizePackForSkin(basePack, resolvedSkin, lang, edictId, activeAffixes);
}

export interface Skin3dAssetSpec {
  skin: SkinId;
  garrisonDefender: {
    nameZh: string;
    nameEn: string;
    geometry: string;
    silhouette: string;
  };
  turrets3d: {
    id: string;
    nameZh: string;
    nameEn: string;
    geometry: string;
  }[];
  source: string;
  license: string;
}

/** 四款皮肤专属 3D 守兵与炮台立体素材清单（含几何规格、来源与许可，大厅 #26188 ⑨） */
export function getSkin3dAssetManifest(): Skin3dAssetSpec[] {
  return [
    {
      skin: 'union-atlas-3d',
      garrisonDefender: {
        nameZh: '星院司仪装甲守卫',
        nameEn: 'Astral Aegis Sentinel',
        geometry: '3D 等轴测八棱柱装甲胸甲 + 悬浮星环肩甲 + 观测目镜球顶',
        silhouette: 'octagonal_prism_sentinel',
      },
      turrets3d: [
        { id: 'crossbow', nameZh: '脉冲棱镜塔', nameEn: 'Pulse Prism Turret', geometry: '3D 双层八角工業台基 + 悬浮旋转红宝石棱镜晶核 + 相位聚焦环' },
        { id: 'fire_brazier', nameZh: '引力锚定井', nameEn: 'Gravity Anchor Well', geometry: '3D 环状磁约束反应釜 + 三重等轴测引力波导管' },
        { id: 'catapult', nameZh: '轨道天基炮', nameEn: 'Orbital Rail Cannon', geometry: '3D 重型构成主义斜切炮塔 + 双联平行电磁加速导轨' },
      ],
      source: '仓库自研程序化 3D 多面体与等轴测立体构件（src/game/spatialMap.ts draw3dTurretAndGarrison），与 Hikos Skin Studio kits.js 同源色板',
      license: 'CC0-1.0 / MIT（项目自有原创代码生成，无第三方版权限制）',
    },
    {
      skin: 'metropolis-riverside-3d',
      garrisonDefender: {
        nameZh: '市政智控机甲守备员',
        nameEn: 'Metro Cyber-Watch Operator',
        geometry: '3D 流线型战术背心立柱 + 青绿全息护目镜 + 无人机通信背包',
        silhouette: 'cyber_operator_3d',
      },
      turrets3d: [
        { id: 'crossbow', nameZh: '电磁拦阻桩', nameEn: 'EMP Bollard', geometry: '3D 玻璃幕墙六棱柱塔身 + 顶部高压特斯拉电弧线圈环' },
        { id: 'fire_brazier', nameZh: '声波减速站', nameEn: 'Sonic Suppressor', geometry: '3D 倾角相控阵声学抛物面碟形天线 + 脉冲振子基座' },
        { id: 'catapult', nameZh: '高能激光矩阵', nameEn: 'Laser Array', geometry: '3D 双塔联动光学棱镜阵列 + 铜金散热鳍片重型转台' },
      ],
      source: '仓库自研程序化 3D 多面体与等轴测立体构件（src/game/spatialMap.ts draw3dTurretAndGarrison），与 metropolis.js 同源色板',
      license: 'CC0-1.0 / MIT（项目自有原创代码生成，无第三方版权限制）',
    },
    {
      skin: 'gothic-cathedral-3d',
      garrisonDefender: {
        nameZh: '圣堂守夜审判执事',
        nameEn: 'Vesper Vigil Arbiter',
        geometry: '3D 哥特尖拱披风立像 + 琥珀提灯权杖 + 银铸肩章高光',
        silhouette: 'vesper_arbiter_3d',
      },
      turrets3d: [
        { id: 'crossbow', nameZh: '圣光钟楼', nameEn: 'Sunlit Belfry', geometry: '3D 玄武岩方尖塔身 + 飞扶壁侧翼 + 四棱锥尖顶圣焰钟室' },
        { id: 'fire_brazier', nameZh: '唱诗共鸣碑', nameEn: 'Choir Resonance Stele', geometry: '3D 玫瑰花窗圆环祭坛 + 八角形圣咏音叉石碑' },
        { id: 'catapult', nameZh: '净罪重弩炮', nameEn: 'Purging Ballista', geometry: '3D 圣堂重型石砌炮座 + 双翼银铸破魔反曲巨弓臂' },
      ],
      source: '仓库自研程序化 3D 多面体与等轴测立体构件（src/game/spatialMap.ts draw3dTurretAndGarrison），与 gothic.js 同源色板',
      license: 'CC0-1.0 / MIT（项目自有原创代码生成，无第三方版权限制）',
    },
    {
      skin: 'harbor-district-3d',
      garrisonDefender: {
        nameZh: '海事防卫装甲水兵',
        nameEn: 'Admiralty Marine Gunner',
        geometry: '3D 海事防风重甲躯干 + 黄铜潜望镜护盔 + 港务信标肩灯',
        silhouette: 'maritime_gunner_3d',
      },
      turrets3d: [
        { id: 'crossbow', nameZh: '防波堤速射炮', nameEn: 'Breakwater Autocannon', geometry: '3D 预制沉箱混凝土台基 + 装甲炮廓 + 双联装穿甲机炮管' },
        { id: 'fire_brazier', nameZh: '声呐水雷信标', nameEn: 'Sonar Mine Beacon', geometry: '3D 黄铜系泊浮筒塔身 + 旋转海事雷达横杆与声呐脉冲球' },
        { id: 'catapult', nameZh: '岸防重型榴弹炮', nameEn: 'Coastal Howitzer', geometry: '3D 铆接深海钢装甲炮塔 + 大仰角岸防巨型榴弹炮管' },
      ],
      source: '仓库自研程序化 3D 多面体与等轴测立体构件（src/game/spatialMap.ts draw3dTurretAndGarrison），与 harbor.js 同源色板',
      license: 'CC0-1.0 / MIT（项目自有原创代码生成，无第三方版权限制）',
    },
  ];
}

