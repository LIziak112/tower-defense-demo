import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const results = resolve('test-results');
await mkdir(results, { recursive: true });
const profile = await mkdtemp(join(results, 'desktop-'));
const launch = () => electron.launch({ args: ['desktop/main.cjs', `--user-data-dir=${profile}`] });
const app = await launch();
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('#td-direct-play').click();
  await page.locator('#td-settings').click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByRole('slider').count(), 3);
  for (const [label, value] of [['音乐', '0.1'], ['战斗音效', '0.4'], ['界面音效', '0.7']]) {
    await dialog.getByLabel(label, { exact: true }).evaluate((input, level) => {
      input.value = level;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  }
  await dialog.getByLabel('分辨率').selectOption('1280x720');
  await dialog.getByRole('button', { name: '无边框全屏' }).click();
  await dialog.getByRole('button', { name: '返回窗口' }).waitFor();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), true);
  await dialog.getByRole('button', { name: '返回窗口' }).click();
  await dialog.getByRole('button', { name: '无边框全屏' }).waitFor();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), false);
  await dialog.locator('[data-action="pause"]').click();
  await page.keyboard.press('KeyK');
  await dialog.getByRole('button', { name: '完成' }).click();
  const data = JSON.parse(await readFile(join(profile, 'saves', 'tower-defense-profile-v1.json'), 'utf8'));
  assert.equal(data.settings.resolution, '1280x720');
  assert.equal(data.settings.keys.pause, 'KeyK');
  assert.deepEqual([data.settings.music, data.settings.effects, data.settings.interface], [0.1, 0.4, 0.7]);
  assert.deepEqual(errors, []);
} finally {
  await app.close();
}

const reopened = await launch();
try {
  const page = await reopened.firstWindow();
  await page.locator('#td-direct-play').click();
  await page.keyboard.press('KeyK');
  assert.equal(await page.locator('#td-pause').getAttribute('aria-pressed'), 'true');
} finally {
  await reopened.close();
}
console.log('Desktop window mode, resolution and file save verified');
