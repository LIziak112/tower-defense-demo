import { ACTIONS, RESOLUTIONS, type Action, type createProfile } from './profile';

type Profile = ReturnType<typeof createProfile>;

export function createSettingsPanel(profile: Profile, language: () => 'zh' | 'en', apply: () => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'td-settings td-panel';
  dialog.setAttribute('aria-labelledby', 'td-settings-title');
  document.body.append(dialog);
  const { settings } = profile.data;
  const desktop = window.tdDesktop;
  const save = () => { apply(); profile.change(); };
  const copy = (zh: string, en: string) => language() === 'zh' ? zh : en;
  let waiting: Action | null = null;
  function render() {
    const title = document.createElement('h2');
    title.id = 'td-settings-title'; title.textContent = copy('设置', 'Settings');
    dialog.replaceChildren(title);
    const label = (text: string, input: HTMLElement) => {
      const row = document.createElement('label');
      row.append(text, input); dialog.append(row);
    };
    const resolution = document.createElement('select');
    for (const value of RESOLUTIONS) resolution.add(new Option(value === 'auto' ? copy('自动', 'Auto') : value, value));
    resolution.value = settings.resolution;
    const mode = document.createElement('button');
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    resolution.onchange = async () => {
      const value = RESOLUTIONS[resolution.selectedIndex];
      if (desktop && !await desktop.display(settings.windowMode, value).catch(() => false)) {
        resolution.value = settings.resolution;
        status.textContent = copy('无法切换分辨率。', 'Could not change resolution.');
        return;
      }
      settings.resolution = value; save();
    };
    label(desktop ? copy('分辨率', 'Resolution') : copy('渲染分辨率', 'Render resolution'), resolution);
    const fullscreen = desktop ? settings.windowMode === 'borderless' : !!document.fullscreenElement;
    mode.textContent = fullscreen ? copy('返回窗口', 'Return to window') : copy('无边框全屏', 'Borderless fullscreen');
    mode.disabled = !desktop && !document.fullscreenEnabled;
    mode.onclick = async () => {
      try {
        if (desktop) {
          const value = fullscreen ? 'windowed' : 'borderless';
          if (!await desktop.display(value, settings.resolution)) throw new Error('Window mode rejected');
          settings.windowMode = value; save();
        } else if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
        render();
        dialog.querySelectorAll('button')[0]?.focus();
      } catch {
        status.textContent = copy('当前窗口无法切换全屏。', 'Fullscreen is unavailable in this window.');
      }
    };
    dialog.append(mode, status);
    for (const [key, text] of [
      ['music', copy('音乐', 'Music')], ['effects', copy('战斗音效', 'Combat effects')], ['interface', copy('界面音效', 'Interface sounds')],
    ] as const) {
      const input = document.createElement('input');
      input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '0.01'; input.value = String(settings[key]);
      input.oninput = () => { settings[key] = input.valueAsNumber; save(); };
      label(text, input);
    }
    const names = [copy('战术暂停', 'Tactical pause'), '1×', '2×', '3×', copy('开波', 'Start wave')];
    for (const [i, action] of ACTIONS.entries()) {
      const button = document.createElement('button');
      button.dataset.action = action;
      button.textContent = settings.keys[action];
      button.setAttribute('aria-label', `${names[i]} · ${button.textContent}`);
      button.onclick = () => { waiting = action; button.textContent = copy('按下新按键…', 'Press a new key…'); };
      label(names[i], button);
    }
    const progress = profile.data.progress;
    const totalStars = Object.values(progress.stars).reduce((a, b) => a + b, 0);
    const summary = document.createElement('p');
    summary.textContent = copy(`累计击杀 ${progress.kills} · 星级合计 ${totalStars} · 图鉴 ${progress.codex.length}`,
      `${progress.kills} total kills · ${totalStars} stars · ${progress.codex.length} codex entries`);
    const close = document.createElement('button');
    close.textContent = copy('完成', 'Done'); close.onclick = () => dialog.close();
    dialog.append(summary, close);
  }
  dialog.addEventListener('keydown', (event) => {
    if (!waiting || event.key === 'Tab') return;
    event.preventDefault(); event.stopPropagation();
    const action = waiting;
    waiting = null;
    if (!event.altKey && !event.ctrlKey && !event.metaKey && event.key !== 'Escape' &&
      !['F1', 'Backquote', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight'].includes(event.code)) {
      const previous = ACTIONS.find((item) => item !== action && settings.keys[item] === event.code);
      if (previous) settings.keys[previous] = settings.keys[action];
      settings.keys[action] = event.code;
      save();
    }
    render();
    dialog.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.focus();
  });
  dialog.addEventListener('close', () => { waiting = null; profile.save(); });
  return { open() { render(); dialog.showModal(); }, get active() { return dialog.open; } };
}
