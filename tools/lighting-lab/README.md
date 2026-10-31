# Bunny 灯光工作台

双击本目录的 `启动灯光工作台.command`，浏览器会打开 <http://127.0.0.1:8767>。需要先安装项目依赖（`npm ci`）。也可从项目根目录运行：

```sh
node tools/lighting-lab/server.cjs --open
```

如果工作台已经启动，重复运行会打开现有页面。其他程序占用该端口时，可以添加 `--port=8768`。

## 调整

1. 选择可可、兰兰、阿雅、琪琪、美莉，或导入自己的 VRM。个人模型只在浏览器本地读取。
2. 选择半身、全身、脸部或灯位全景；拖动旋转、滚轮缩放、右键平移。
3. 调整整体亮度、环境光、主光、补光、轮廓光、顶光、颜色、位置和照向位置。点击“移动此灯”后可拖动三维坐标轴。“单独看”临时只显示这一盏灯。
4. 可继续调整高光处理、曝光、聚光范围、距离衰减、阴影和材质自发光。材质细节默认沿用模型原始数值，打开对应开关后才覆盖。
5. 按住“对比原版”查看此角色的原始照明，松开恢复；也可从柔和自然或柔光棚拍预设开始。
6. 各角色分别记录。调好后点击“保存全部参数”，或“导出 JSON”保留一份文件。

背景、地面、动作、取景和灯位标记用于观察，不会写入照明配置。灯位坐标以米为单位，X 为左右、Y 为高度、Z 为前后；平行光的亮度不随距离改变，位置和照向位置共同决定照射方向。

## 参数保存与接入

保存文件为项目根目录的 `.cache/lighting-lab/profiles.json`，带格式标记 `workbunny-lighting/v1`。内置角色的默认值来自 `src/renderer/avatar-lighting-profiles.mjs`，当前已采用工作台确认的第 6 次保存。模型系数已合并进各盏灯的强度，之后应用配置时不要再乘一次。

未保存调整会暂存到当前浏览器的本地草稿；点击保存后，以磁盘文件为准。多人或多个页面同时编辑会检测保存版本冲突，避免覆盖其他页面的结果。导入 JSON 会合并各模型设置，原有未涉及的模型仍保留。自定义模型的参数按文件内容摘要识别，再次导入同一模型即可恢复。

预览和 Bunny 主程序共用 `src/renderer/avatar-lighting.mjs` 的照明实现。主程序通过 `lightingForAvatar(key, fallbackScale)` 读取已确认配置，以 `createAvatarLighting(...).apply(lighting, 1)` 应用。工作台后续保存只更新调试文件；确认新参数后，再同步到正式配置。个人模型未配置时沿用原始照明回退。工作台不修改 Bunny 的个人资料库。

服务仅绑定本机回环地址，只开放预览所需的资源和参数接口，不读取 API Key、钥匙串或聊天记忆。临时文件位于已忽略的 `.cache` 中，不进入公开源码包。

## 检查

```sh
node --test test/test-avatar-lighting.mjs
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/test-lighting-lab.cjs
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/test-avatar-lighting-app.cjs
```

后两项使用隔离的临时资料目录，验证真实 VRM 渲染变化、角色切换、原版对比、参数保存、冲突保护，以及主程序实际应用的完整配置。第三项可通过 `WORKBUNNY_LIGHTING_APP_ROOT` 指定安装包内的应用代码路径。
