# 0.9.4 动效与性能审查

| Before | After | Why |
| --- | --- | --- |
| 拖动每帧经 Vue 写入 left、top 及父级 CSS 变量 | 合并指针事件，每帧最多直接写一次 transform，结束后提交坐标 | 减少响应式更新、样式重算与布局 |
| 折射贴图随尺寸变化重建，含三通道位移及混合 | 单次位移、最长边 384 像素、4 项缓存，稳定 120 毫秒后空闲生成 | 限制绘图成本，避开交互帧 |
| 展开与页签动画较长，快速触发会重启 | 展开 160 / 收起 100 / 页签 140 毫秒，最多 4 像素位移；中断时采样同目标当前状态 | 保留方向与状态反馈，操作立即生效 |
| Element Plus 卡片默认 transition:all 会补间玻璃滤镜 | 卡片 transition:none；页签滑块仅 transform，按钮仅 transform/opacity | 避免玻璃滤镜逐帧重绘与无关颜色补间 |
| 拖动期间仍显示昂贵折射边缘 | 交互期间减小模糊并隐藏折射边缘，结束后恢复 | 保留整体玻璃材质，缩小交互开销 |
| 永久运行或取消后的资源可能影响后续交互 | 临时 will-change，指针捕获、遮罩及动画有完成/取消/失焦清理 | 避免遗留图层与输入状态 |

**Approve。** 当前使用路径未发现阻断回归。实现见 `panel-interactions.js:3`、`panel-motion.js:2`、`liquid-glass.js:4`、`ui-panel.css:19`。

- 位移和淡入使用 transform/opacity，立即更新 vShow、焦点和任务状态。拖动无缓动，不等待动画完成。
- 减少动态效果使用 80 毫秒纯淡入；减少透明度时关闭滤镜，包括拖动与切换状态。悬停样式限精细指针；触摸标题在手势开始前声明 touch-action:none。
- 快速展开、收起、切换只保留一个应用动画。拖动会取消内容动画；结束、隐藏和组件清理均恢复临时状态。
- 玻璃有独立 BFCache 暂停/恢复与页面销毁清理。当前面板只挂载一次；未来增加主动 app.unmount 路径时需同时接入玻璃 disposer。

验证依据为 561 项自动测试及真实 Edge 扩展对比，记录见 `tests/verification-0.9.4.log` 与 `tests/verification-0.9.4-motion-browser.log`。帧间隔是本机 headless 软件渲染下的观察值，不代表所有设备的 60/120 FPS 保证；CDP trusted 触摸不是物理触屏设备测试。

Figma 已读取原有可编辑稿，首次写入被 Starter MCP 调用额度限制拒绝。本轮没有云端变更或原生关键帧预览；待执行脚本与阻断信息见 `design/figma-motion-build.js` 和 `design/figma-motion-state.json`。
