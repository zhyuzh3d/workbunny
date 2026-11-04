# WorkBunny 图标资源

应用图标与界面标志分别维护，避免重新打包时互相覆盖。

| 原始资源 | 用途 | 生成产物 |
| --- | --- | --- |
| `app-icon-source.png` | 维护者提供的粉色兔耳应用图 | `icon.svg`、`icon.png`、`icon.icns` |
| `logo.svg` | 原有黑白小兔子，窗口标题栏和状态菜单使用 | `logo-white.svg`、`window-icon.png`、`trayTemplate.svg` 及 1x/2x PNG |

`logo.svg` 保持对称兔头与长耳轮廓，菜单栏使用模板图像自动适应系统明暗。应用图按 macOS 图标边距和圆角生成；标准原图保存完整画面，导入时去除图像元数据。其余产物自动生成，不分别手工修改。

```sh
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron tools/make-icons.cjs
```

更新应用原图：

```sh
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron tools/make-icons.cjs --application-source /path/to/application-icon.png
```

`tools/brand-assets.cjs` 统一列出输入和产物，构建及源码发行使用同一清单。正常打包会重新生成图标；更新应用图不会改写黑白标志的来源。
