# Tower Defense Demo 部署手册 (DEPLOY.md)

## 独立静态页部署

本项目纯前端，静态资源已经完成 Vite 构建。
上线步骤如下：

1. 克隆代码后，在项目根目录运行 \`npm install\`。
2. 运行 \`npm run build\`。
3. 构建产物位于 \`dist\` 目录下。
4. 将 \`dist\` 目录整体上传至 CDN 或将其配置为 Nginx/Apache 的 \`root\` 即可。

## Hikos 皮肤整合 (按需)
1. 把 \`dist/assets\` 和 \`dist/index.html\` 中的逻辑嵌入 Hikos 页面即可。

## 环境要求
- Node.js 18+ (构建阶段)
- 支持 ES 模块的现代浏览器
