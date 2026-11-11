# 世界模式协议（塔防 ↔ Hikos 宿主）

大厅 #27514 的根治方案：战场不再是盖在屏幕上的一层画，而是长在宿主地图的真实道路上。

- 宿主把场景的**真实几何**（世界坐标的道路中心线、建筑占位、水域）给游戏；游戏在真实道路图上选路线、在路边真实空地上排塔位，规则模拟直接跑在这份几何上（射程按世界距离算）。
- 路线、塔位、塔、敌人、弹道、射程圈、起终点这些「长在地图上」的东西，由**宿主画进它自己的三维场景**：同一台相机、同一次渲染、有深度遮挡。地图怎么缩放、平移、旋转，它们都贴在道路上。
- 游戏 iframe 只剩界面（顶栏、军师卡、议事框）和贴着世界位置的跳字。跳字和点选塔位用宿主**每一帧**推来的相机矩阵投影，与三维画面逐像素一致。

本协议是 postMessage v1 的加法：宿主不给 `map.world`，游戏照旧走屏幕模式；老消息（`td:ready` / `td:state` / `td:exit` / `td:resize` / `td:advisor:*` / `td:settle:*` / `td:restore`）不变。来源校验照旧（游戏只认 `event.source === window.parent` 且源等于宿主源）。

实现：`src/game/worldField.ts`（战场生成）、`src/game/worldMode.ts`（线格式与投影，纯函数）、`src/game/main.ts`（世界模式的收发、输入与跳字）、`src/game/hikos.ts`（桥）。

## 坐标约定

- 世界坐标就是宿主三维场景的坐标：`x`、`z` 是地面，`y` 朝上。单位是场景单位。
- 游戏内部的逻辑格与世界坐标的换算在 `td:field` 的 `unit` 与战场原点里：`世界 x = ox + 毫格 / 1000 × unit`。宿主不需要关心逻辑格，线上全部是世界坐标。
- 敌人的位置用「第几条路线 + 沿路线的世界弧长」表示。宿主沿自己手里那条同样的折线取位置、朝向和路面高度。

## 宿主 → 游戏

### `hikos:context` / `hikos:map` 里的 `map.world`

```
world = {
  v: 2,
  skin, layout, scene,                       // 字符串，只用于日志与战场指纹
  bounds: { minX, maxX, minZ, maxZ },
  roads:  [{ id, kind, w, pts: [[x, y, z], …], virtual? }],   // 中心线折线，w = 路面宽，y = 路面高度（参考值）
  places: [{ key, kind: 'home' | 'landmark' | 'entity', label, x, z, r }],   // 建筑占位（r = 占位半径）
  blocks: [[x, z, r], …],                    // 其它不能压的东西（装饰建筑、行道树…）
  water:  [{ pts: [[x, z], …], w }],         // 水域带：中心线 + 宽度
  land?:  [[minX, minZ, maxX, maxZ], …]      // 有这个字段时，塔位必须落在其中一块陆地矩形里（港湾：只有码头是陆地）
}
```

- `virtual: true` 的道路是场景里原本没有、开战时由宿主搭出来的连接段（港湾的浮桥）。路线用到了哪几段，见 `td:field` 路线的 `fl`。
- 游戏对它做限量与校验（`parseWorldMap`）。没有道路、路网不通、排不出至少 4 个塔位时，游戏退回屏幕模式。
- 同一份 `world` 再发一次，游戏不动。几何变了（道路或建筑变了），游戏在新战场上重新部署本关。
- **宿主只在自己实现了本文件全部内容时才发 `world`**：游戏一旦进入世界模式，就不再自己画路线、塔和敌人。

### `hikos:camera`（相机变了就发，至多每帧一条）

```
{ type: 'hikos:camera', v: 1, seq, w, h, m: [16 个数], ppu, azimuth, pitch, zoom }
```

- `m`：世界坐标 `(x, y, z, 1)` → **游戏 iframe 视口的 CSS 像素** `(sx, sy, 深度, w)` 的 4×4 矩阵，**行主序**，已含视口变换；三维画布与 iframe 不重合时，偏移也算在里面。
  `sx = (m0·x + m1·y + m2·z + m3) / w`，`sy = (m4·x + m5·y + m6·z + m7) / w`，`w = m12·x + m13·y + m14·z + m15`（正交相机恒为 1）。
- `w`、`h`：这个矩阵对应的 iframe CSS 宽高。
- `ppu`：地面上 1 个世界单位在屏幕上的像素数（正交相机处处相同）。游戏用它定点选半径。
- 必须是宿主**渲染这一帧所用的同一台相机**，并且和这一帧在同一个动画帧里发出。游戏收到后立刻按它重画跳字。
- 每帧一条的消息不进游戏的调试日志；读点在 `__td.world.camera`。

### `hikos:ground`（对 `td:field` 的回执，可选）

```
{ type: 'hikos:ground', v: 1, field: <td:field 的 id>, pads: [y, …], routes: [[y, …], …] }
```

- `pads[i]`：第 i 个塔位处的地面高度；`routes[k][j]`：第 k 条路线第 j 个折点处的路面高度。数组长度必须与 `td:field` 对得上，`field` 必须等于当前战场 id，否则游戏忽略。
- 游戏只拿它做拾取与跳字投影。没收到之前用 `world.roads` 里的参考高度（引道段取最近的有高度的折点）。地形起伏大的皮肤建议发。

## 游戏 → 宿主

### `td:field`（战场，内容变了才发）

```
{
  type: 'td:field', v: 1,
  id,                    // 几何指纹：id 相同 = 同一块战场，只换文案 / 配色，不必重建三维物件
  unit,                  // 1 逻辑格 = unit 世界单位；塔、敌人、塔座的三维尺寸按它定
  padR,                  // 塔座占地半径（世界单位）
  level, skin, lang,
  routes: [{ branch, len, w, pts: [[x, y | null, z], …], wd: [宽, …], fl: [标记, …] }],
  pads:   [[x, z], …],   // 塔位，下标 = 槽位号（军师说的槽位、td:frame 里的塔位都是它）
  spawn:  { key, label, title, x, z },
  spawn2: { … } | null,  // 分支路线的起点
  base:   { key, label, title, x, z },
  towers:  [{ id, name, color, cost, range, model: 'rapid' | 'area' | 'heavy' }],   // range 是世界单位
  enemies: [{ id, name, color, model, scale }],
  palette: { accent, danger, ok, paper, ink }
}
```

- `routes[0]` 是主线，其余是分支。`pts` 含起终点的入口引道；`y = null` 表示没有参考高度，由宿主按地形取。`wd[i]`、`fl[i]` 描述从第 i 个点出发的那一段：路面宽度，以及标记位（`1` 引道：从路面走到建筑门口的一小段；`2` 浮桥：宿主要把它搭出来）。
- 不带标记位 `1` 的每一段都在 `world.roads` 里某条道路的路面内（离中心线不超过半个路宽），包括引道与路面相接处的那段倒角（游戏 0.9.1 起；此前引道拐上很窄的路时，倒角靠引道的一头会露在路缘外）。引道段本来就不在路上。
- `spawn` / `base` 的 `key` 是 `world.places` 里那座真实建筑的 key（没有绑定建筑时为 `null`），`title` 是可以直接上铭牌的文字（如「起点·哥德尔」）。
- 离开世界模式时游戏发 `{ type: 'td:field', v: 1, id: null }`，宿主把它画的战场收掉。
- `td:ready` 仍然是游戏的第一条出站消息；`td:field` 在它之后。

### `td:frame`（战况，变了才发，至多每个动画帧一条）

```
{
  type: 'td:frame', v: 1, field: <id>, tick,
  phase: 'lobby' | 'build' | 'wave' | 'won' | 'lost', paused,
  pads: "0124…",                                  // 每个塔位一个字符：0 空 · 1 悬停 · 2 军师建议 · 3 推演中 · 4 已占
  towers:  [[iid, 塔位, towers 下标, 标记], …],    // 标记位：1 刚落成（下一 tick 生效）· 2 后坐 · 4 阵型协同
  enemies: [[iid, enemies 下标, 路线下标, 世界弧长, 血量 0..1, 标记], …],   // 标记位：1 受击闪 · 2 被弹坑减速 · 4 倒下
  shots:   [[塔 iid, 敌 iid, 命中点 x, 命中点 z], …],   // 仍在显示的弹道（约 115 毫秒）
  ring:    [塔位, 世界半径] | null,                // 射程圈：悬停的塔位 / 点选的塔 / 推演中的方案
  links:   [[塔位 A, 塔位 B, 种类], …],            // 阵型协同连线
  craters: [[路线下标, 世界弧长], …],              // 炸毁的路段
  tips:    [[塔位, 文字], …],                      // 塔位铭牌（军师建议「A·磁暴弩塔」、悬停「磁暴弩塔 60 CP」）
  fx:      [[种类, x, z], …],                      // 一次性事件：die 击破 · leak 漏到终点 · blast 炸路 · demolish 推倒建筑 · build 塔落成
  demolished: [建筑 key, …],
  base: [当前血量, 上限], wave: [已开波数, 总波数]
}
```

- 除 `tick` 外内容与上一条完全相同时不发（建造期没人动 = 零流量）。宿主不要把「没收到新帧」当成断线。
- `fx` 每条只出现一次；不认识的种类忽略。
- 宿主收到的 `field` 与自己手里的战场 id 不一致时丢弃这一帧（新的 `td:field` 马上就到）。

### `td:camera`（把画布上的手势交还给地图相机）

游戏画布盖在地图上，手势落在游戏里。游戏把它们原样转给宿主，宿主用引擎原生的同一组算法与上下限去动相机：

| kind | 字段 | 触发 |
| --- | --- | --- |
| `rotate` | `dx`, `dy`（像素增量） | 单指 / 左键拖动 |
| `pan` | `dx`, `dy` | Shift 或中键拖动 |
| `zoom` | `dy`（滚轮像素，行 / 页已折算） | 滚轮、触控板 |
| `pinch` | `scale`（相对上一条的比例）, `dx`, `dy`（双指中点位移） | 双指捏合、Safari gesture 事件 |
| `reset` | 无 | 双击空白处 |
| `frame` | `minX`, `maxX`, `minZ`, `maxZ`, `insets: { top, right, bottom, left }` | 一块战场第一次出现（或换了）时发一次：请宿主把镜头对准战场，`insets` 是游戏界面挡住的边（像素）。宿主可以不理会。 |

点按不转发：游戏用相机矩阵自己判断点中了哪个塔位（投影后取最近的一个，半径 `max(24, 1.7 × ppu)` 像素，触控 32）。

### `td:destruct` / `td:restore`

- 世界模式下炸路**不再发** `td:destruct kind:'road'`（它带的是逻辑格坐标）；弹坑在 `td:frame.craters` 里，宿主画在真实路面上。
- 推倒建筑仍发 `td:destruct { kind: 'building', key, label, cx, cy, wx, wz }`：`key` 是 `world.places` 里那座真实建筑，`wx` / `wz` 是它的世界位置。
- 重开、退出、换关时游戏发 `td:restore`，宿主把推倒的建筑复原。

## 调试与测试读点

- `?fielddebug`：把游戏自己算的路线（主线洋红、分支青色）、塔位（黄点）、敌人（红点）按相机矩阵描在游戏画布上，与宿主画进三维场景的那一份叠着看，两者应当重合。
- `window.__td.world`：战场几何、最近一条 `td:field` / `td:frame`、当前相机，以及 `padScreen(i)` / `routeScreen(路线, 弧长)` / `enemyScreen(iid)`（用同一个相机矩阵算出的屏幕位置）。
- `window.__td.triggerDemoCombatVfx()`：世界模式下沿真实路线摆 6 座塔、8 个敌人并打一轮齐射；`window.__td.setPaused(true)` 冻结局面，方便逐档截图。
- 单测：`tests/game/worldMode.test.ts`（投影、拾取、线格式）、`tests/game/worldField.test.ts`（真实地图上的路线与塔位）；端到端：`tests/e2e/world-mode.spec.ts`（假宿主发真实地图与相机矩阵）。
