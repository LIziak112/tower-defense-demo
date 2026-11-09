import { applyGamePalette } from './gamePalette';
import { installShortcuts } from './shortcuts';
import { createBattleLoop } from './battleLoop';
import { renderBattleHud } from './gameHud';
import { buildFailure, createLiveBattle, checksum, type BattleState, type ContentPack } from '../runtime';
import { stressCommands, stressPack } from '../content/stress';
import { openingCampaign, onOpeningReload } from '../content/opening';
import { artilleryTrial } from '../content/artilleryTrial';
import { PALETTES, type Palette } from './palettes';
import { MockProvider } from '../ai/mock';
import { createHostBridge, type GameState, type HostContext } from './hikos';
import { paletteForContext } from './skins';
import { createAdvisorView } from './advisorView';
import { createLobby } from './gameLobby';
import { createBoard } from './boardView';
import { createEventBus } from './eventBus';
import { createBattleFx } from './battleFx';
import { createBattleAudio } from './audio';
import { createProfile, trackProgress } from './profile';
import { createSettingsPanel } from './settingsPanel';
import { createTooltips } from './tooltips';
import { createTacticalOverlay } from './tacticalOverlay';
import './tactical.css';
const params = new URLSearchParams(location.search);
const SEED = Number(params.get('seed') ?? 20261107) >>> 0;
const DEBUG = params.has('debug');
const benchmark = DEBUG && params.has('stress');
let campaign = openingCampaign();
onOpeningReload((next) => {
  const wasCampaign = pack === campaign;
  campaign = next;
  if (wasCampaign && !inLobby) startWith(campaign);
  else if (wasCampaign) { pack = campaign; state = createLiveBattle(pack, SEED); board.clear(); renderHud(); }
});
const provider = new MockProvider();
const legacyPalette = [params.get('palette'), params.get('theme')].find((k) => k && k in PALETTES) ?? null;
const hostLog: Record<string, unknown>[] = [];
const advisorReplyCbs: ((m: Record<string, unknown>) => void)[] = [];
const advisorStreamCbs: ((m: Record<string, unknown>) => void)[] = [];
const explicitInsitu = params.get('insitu');
const bridge = createHostBridge(window, {
  onContext: applyContext,
  onVisibility: setHostVisible,
  onMap: () => { applyPalette(); board.sync(); },
  onSize: () => { board.sync(); board.fit(); },
  onAdvisorReply: (m) => { for (const cb of advisorReplyCbs) cb(m); },
  onAdvisorStream: (m) => { for (const cb of advisorStreamCbs) cb(m); },
  onAny: (m) => { if (DEBUG) hostLog.push(m); },
});
if (DEBUG) { (window as any).__q = Object.fromEntries(params); (window as any).__msgs = hostLog; }
const hikosMode = bridge.embedded || params.has('skin') || params.has('accent');
const trial = !bridge.embedded && !benchmark && params.has('artillery');
let pack = trial ? artilleryTrial(campaign) : benchmark ? stressPack(campaign) : campaign;
const isInsitu = () => trial || explicitInsitu === '0' ? false : (explicitInsitu === '1' || explicitInsitu === 'true' || bridge.embedded || !!bridge.context.insitu || !!bridge.context.map);
let currentTheme = legacyPalette ?? (hikosMode ? 'hikos' : 'default');
let theme: Palette = legacyPalette ? PALETTES[legacyPalette] : hikosMode ? paletteForContext(bridge.context) : PALETTES.default;
let lang = bridge.context.lang;
let state: BattleState = createLiveBattle(pack, SEED);
let selected = '';
let inspectedTower: number | null = null;
let inLobby = !trial && !benchmark && !params.has('skiplobby');
let speed = 1;
let paused = false;
let hostHidden = false;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const motion = () => !reducedMotion.matches && !bridge.context.reducedMotion;
const bus = createEventBus();
const fx = createBattleFx(bus, motion);
const profile = createProfile();
const audio = createBattleAudio(bus, profile.data.settings);
trackProgress(bus, profile, () => state, () => !DEBUG && !trial);
const settings = createSettingsPanel(profile, () => lang, () => { audio.apply(); board.sync(); board.fit(); });
const tips = createTooltips();
const overlay = createTacticalOverlay(tips, () => state, () => lang === 'zh', startWave, (iid, mode) => dispatch({ type: 'targeting', iid, mode }));
const root = document.getElementById('game-container')!;
if (trial) document.documentElement.dataset.artillery = 'true';
const canvas = document.createElement('canvas');
canvas.id = 'board';
const hud = document.createElement('div');
hud.id = 'hud';
const dbg = document.createElement('pre');
dbg.id = 'debug';
dbg.style.display = DEBUG && !benchmark ? 'block' : 'none';
const advisorBox = document.createElement('div');
advisorBox.id = 'advisor';
root.append(hud, canvas, advisorBox, dbg);
const advisor = createAdvisorView({
  bridge, tactical: !trial && !params.has('notactical'), advisorBox, reply: advisorReplyCbs, stream: advisorStreamCbs,
  read: () => ({ state, lang, inLobby }), isInsitu, enter: enterBattleInSitu,
  fit: () => board.fit(), run: (commands) => runCommands(commands, false),
});
const { session, schedule: scheduleCard } = advisor;
const loop = createBattleLoop({
  bus, fx, session, hud, benchmark, lang: () => lang, saveRecord: () => !DEBUG && pack === campaign, state: () => state,
  frozen: () => paused || inLobby || hostHidden || settings.active, hostHidden: () => hostHidden, speed: () => speed,
  renderHud, scheduleCard, draw: (now, tickFraction) => board.draw(now, tickFraction), hide: () => board.hide(),
  beginAudioEvents: audio.beginEvents,
  ready: () => { bridge.ready(); reportState(); },
});
const { runCommands, dispatch } = loop;
const boardState = {
  get state() { return state; }, get inspectedTower() { return inspectedTower; }, get selected() { return selected; },
  get inLobby() { return inLobby; }, get hostHidden() { return hostHidden; }, get paused() { return paused; }, get speed() { return speed; },
  get confirmingUntil() { return loop.confirmingUntil; }, get invalidUntil() { return loop.invalidUntil; },
  get theme() { return theme; }, get lang() { return lang; }, get cardView() { return advisor.cardView; }, get previewId() { return advisor.previewId; },
};
const board = createBoard({
  canvas, hud, dbg, advisorBox, fx, tips, overlay, motion, isInsitu, trial, recorded: loop.recorded,
  embedded: bridge.embedded, hostMap: () => bridge.context.map ?? null,
  resolution: () => profile.data.settings.resolution,
  read: () => boardState,
  camera: (event) => bridge.send(event),
  chooseTower: (id) => { selected = id; inspectedTower = null; renderHud(); },
  cancel: cancelPlacement,
  slow: () => { speed = 1; renderHud(); },
  select: (x, y) => {
    if (hostHidden || (state.phase !== 'build' && state.phase !== 'wave')) return;
    if (inLobby) enterBattleInSitu();
    const tower = state.towers.find((item) => item.cx === x && item.cy === y);
    inspectedTower = tower?.iid ?? null;
    if (tower || !selected) { selected = ''; renderHud(); return; }
    const towerId = selected;
    if (!buildFailure(state, towerId, x, y)) selected = '';
    session.notePlayerBuild();
    dispatch({ type: 'build', tower_id: towerId, x, y });
  },
});
function applyPalette() {
  applyGamePalette(theme, hikosMode ? bridge.context.theme : 'night', isInsitu(), bridge.context.skin, lang);
}
function applyContext(c: HostContext) {
  lang = c.lang;
  advisor.setContext(c);
  if (!legacyPalette) { theme = paletteForContext(c); currentTheme = 'hikos'; }
  applyPalette();
  board.sync();
  if (inLobby) lobby.refresh();
  renderHud();
  scheduleCard();
}
function setHostVisible(visible: boolean) {
  hostHidden = !visible;
  audio.visible(visible);
  if (visible) loop.resetClock();
  renderHud();
}
applyPalette();
function gameState(): GameState {
  if (state.phase === 'won') return 'won';
  if (state.phase === 'lost') return 'lost';
  if (inLobby) return 'idle';
  if (paused || hostHidden) return 'paused';
  return 'playing';
}
function reportState() { bridge.state(gameState()); }
function renderHud() {
  renderBattleHud({
    state, read: () => state, hud, lang, paused, hostHidden, inspectedTower, selected, tips, inLobby, speed,
    insitu: isInsitu(), embedded: bridge.embedded, hikosMode, currentTheme, revenging, trial,
    clearedWaves: loop.clearedWaves, bestWave: loop.bestWave, waveScore: loop.waveScore, toast: loop.toast, campaign: pack === campaign,
    actions: {
      select: (id) => { selected = id; inspectedTower = null; renderHud(); },
      startWave, togglePause, speed: (value) => { speed = value; renderHud(); },
      settings: settings.open, lobby: () => showLobby(), revenge: () => { void revenge(); },
      theme: (id) => {
        currentTheme = id; theme = PALETTES[id]; applyPalette();
        const url = new URL(location.href); url.searchParams.set('palette', id); url.searchParams.delete('theme');
        history.replaceState(null, '', url);
      },
      exit: () => bridge.exit(),
      upgrade: (command) => { session.notePlayerBuild(); dispatch(command); },
    },
  });
  reportState();
  board.fit();
}
function enterBattleInSitu() {
  if (!inLobby) return;
  inLobby = false;
  lobby.hide();
  session.reset(state);
  renderHud();
  scheduleCard();
}

function togglePause() {
  if (inLobby || hostHidden) return;
  paused = !paused; loop.resetClock(); renderHud();
}

function startWave() {
  if (state.phase === 'won' || state.phase === 'lost') { startWith(pack); return; }
  if (state.phase !== 'build' || paused || hostHidden) return;
  if (inLobby) enterBattleInSitu();
  if (trial) {
    board.cancelPlacement();
    selected = ''; inspectedTower = null;
  }
  dispatch({ type: 'start_wave' });
}

const lobby = createLobby({
  root, embedded: bridge.embedded, lang: () => lang, agent: advisor.agent,
  provider, llm: advisor.llm,
  onShow: () => { inLobby = true; advisorBox.style.display = 'none'; },
  enter: enterBattleInSitu, playCampaign: () => startWith(campaign), start: startWith, reportState,
});
const { show: showLobby, design } = lobby;
let revenging = false;
async function revenge() {
  if (revenging) return;
  revenging = true; renderHud();
  try {
    await design(session.debrief(state));
  } finally {
    revenging = false;
    renderHud();
  }
}
function startWith(p: ContentPack) {
  pack = p;
  selected = '';
  inspectedTower = null; advisor.clear();
  paused = false;
  state = createLiveBattle(pack, SEED); loop.reset();
  board.clear();
  inLobby = false; lobby.hide(); renderHud();
  session.reset(state);
  scheduleCard();
}
(window as any).__lobby = { gen: (tx: string) => { void design(tx); } };
function cancelPlacement() {
  board.cancelPlacement();
  selected = ''; inspectedTower = null; renderHud();
}
installShortcuts({
  dbg, debugEnabled: DEBUG, keys: profile.data.settings.keys, settingsOpen: () => settings.active, togglePause, startWave,
  cancel: cancelPlacement,
  speed: (value) => { speed = value; renderHud(); }, debugGold: () => dispatch({ type: 'debug_add_gold', amount: 100 }),
});
board.sync();
if (inLobby) showLobby(); else { lobby.hide(); session.reset(state); }
if (benchmark) runCommands(stressCommands(pack), false);
renderHud();
loop.start();
(window as any).__td = {
  get state() { return state; },
  checksum: () => checksum(state),
  recorded: loop.recorded,
  metrics: loop.metrics,
  get audioMode() { return audio.mode; },
  enableLatencyProbe: benchmark ? board.enableLatencyProbe : undefined,
  get host() { return { embedded: bridge.embedded, origin: bridge.origin, context: bridge.context, hidden: hostHidden, palette: currentTheme }; },
  get insitu() { return isInsitu(); },
  get spatial() { return board.inspect(); },
};
(window as any).__advisor = advisor.debug((...commands) => { loop.queue.push(...commands); });
