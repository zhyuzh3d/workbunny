# Workbunny 动作质量验收（2026-10-25）

## 覆盖范围

- 播放链路：`createVRMAnimationClip` retarget → `motion-cut.js` 按窗口裁切 → `ground.js` 统一地面和锁脚 → `AnimationMixer` 播放。
- 资产：`src/renderer/assets/motions/*.vrma` 全部 92 个文件；源资产未改写。
- 审计工具：`node tools/motion-quality-audit.mjs`，JSON 结果写到 `tools/motion-quality-report.json`。

## 全量审计结果

| 项目 | 结果 |
| --- | ---: |
| 已解析 / 总资产 | 92 / 92 |
| 解析失败 | 0 |
| 动画通道 | 4,744 |
| 已纳入轨道分析 / 不支持通道 | 4,744 / 0 |
| 关键帧 | 1,010,283 |
| 四元数轨道 / 位移轨道 | 4,652 / 92 |
| 有检查发现的轨道 | 85 |
| 孤立旋转/位移尖峰候选 | 0 |
| 相邻四元数符号不连续 | 114 处 |
| 声明循环动作 | 11 |
| 超阈值循环接缝候选 | 40 条轨道 |
| 按清理器重放的四元数归一化 | 0 |
| 符号连续处理翻转的关键帧 | 1,286 个 |
| 自动修补的孤立尖峰 | 0 |
| 自动平滑的循环接缝尾段 | 39 条轨道 |

审计器将 glTF 的 `rotation`/`translation` 路径映射为 Three.js 的 `quaternion`/`position` 轨道后再分析。之前漏掉了该映射，导致轨道分类和零异常结论无效；本报告是修正映射后的结果。检查发现的 85 条轨道包含四元数符号跳变和循环接缝，并不等于坏动作。114 是原始相邻符号不连续数；为形成一条符号连续序列，处理器会从不连续点开始翻转后续等价四元数，因此实际重写 1,286 个关键帧符号。

没有发现孤立单关键帧反向尖峰，也没有把非循环的急转、跳跃或挥手判作问题。循环接缝只在 `MOTIONS.loop` 动作上处理：39 条轨道通过尾段平滑过渡到首姿态，首姿态本身保持不变；余下 1 条是 `idle_walk_mocopi` 的 `root.position`，首尾差约 56.53 个单位，超过安全限值，保留原轨道避免将角色大幅拉回起点。

## 运行时清理策略

新增的 `src/renderer/motion-quality.mjs` 不写回 `.vrma`：

- 四元数单位化，并统一相邻关键帧符号，避免等价四元数导致插值绕远路。
- 只在前后姿态近似相同、中心关键帧突然偏转且随即反向时修复旋转尖峰。
- 只在位移/缩放单点偏差超过阈值且大于相邻变化 5 倍时修复；位移阈值按素材单位计算，不假定全库采用同一单位。
- 对 `MOTIONS.loop === true` 的动作，首尾旋转差超过 0.06 rad 时追加 0.25–0.8 秒的平滑尾段；窗口长度随角度变化。位移差超过 0.01 且不超过 0.5 个源单位、缩放差不超过 0.4 时也会处理。超大根位移保留并报告，不跨越窗口拖回起点。
- 不猜测全零或非有限四元数的正确姿态，留在 `findings` 供审查。

## app.js 集成建议

主任务已在 `src/renderer/app.js` 集成以下路径：

1. 导入 `processMotionClip` 和 `crossFadeMotionAction`。
2. 在 `rebuildClips()` 完成 `groundAllClips()` 后，对每条 clip 调用：

   ```js
   const loop = MOTIONS.find((m) => m.key === id)?.loop === true;
   const quality = processMotionClip(clip, { loop });
   ```

   清理应用在 retarget、裁切、地面/IK 烘焙之后，覆盖最终会播放的轨道。

3. 维护 `motionActions = new Set()`，每次 `mixer.clipAction(clip)` 后登记；重建 mixer 时清空。替换当前 `next.reset().play(); next.crossFadeFrom(currentAction, fade, false)` 为：

   ```js
   crossFadeMotionAction(next, currentAction, fade, motionActions);
   ```

   首次播放没有 `currentAction` 时沿用直接 `reset().play()`。同一 action 已经是 current 时先走同 action 分支，避免无意义重置淡变状态。

根因来自 Three.js 的 `AnimationAction.fadeOut()`：它每次按 `[1, 0]` 排淡出权重。快速打断淡入/淡出时，旧淡变被覆盖，新淡出又从 1 开始；当前权重不足 1 的 action 会在下一次 mixer 更新中回弹。新增 helper 先读取 `getEffectiveWeight()`，取消旧淡变，再把该值设为新淡变的基础权重，并淡到 0；被打断的其它 action 也按当前权重收尾。

## 验证与限制

- `node --test test/motion-quality.test.mjs`：7 项通过，覆盖轨道修正、非循环快速转身保留、小/大循环旋转接缝尾段、零四元数不猜测、真实 Three.js mixer 快速切换权重连续。
- `node tools/motion-quality-audit.mjs`：92/92 个资产解析成功，断言四元数和位移轨道均被分类，JSON 报告已更新。
- 本验收是关键帧数据与真实 mixer 单元层证据；未启动正式应用，也未在每个模型上逐段目视播放。因此无法据此断言每个事件动作的语义表演都自然。事件动作选择/姿态语义仍需在产品实际角色上做视觉验收。
