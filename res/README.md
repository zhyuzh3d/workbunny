# Workbunny 标准标志

`logo.svg` 是唯一手工维护的标准源：保留馒头形头部和长耳轮廓，沿 `x=64` 严格镜像；双眼为宽 6、高 15.5、端部半径 3 的竖向胶囊。

默认黑色。深色背景可使用 `logo-white.svg`；界面中的 CSS 遮罩使用同一份标准源，颜色由 `--bunny-logo-color` 控制。菜单栏使用 macOS 模板图像自动适应明暗背景。

其余 SVG、PNG、ICNS 均由标准源生成，请勿分别修改：

```sh
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron tools/make-icons.cjs
```

`tools/brand-assets.cjs` 统一列出所有品牌资源，供生成工具和发行资源复制工具共同使用。兼容入口 `tools/make-tray-icon.cjs`、`tools/make_icon.py` 也调用同一生成工具。

正常打包时会自动重新生成全部图标，避免修改 SVG 后遗漏菜单栏或应用图标。
