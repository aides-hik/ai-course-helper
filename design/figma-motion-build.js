// Prepared Figma Plugin API script; not executed because the Figma Starter
// MCP tool-call quota was exhausted before the first write.
// Run through use_figma with skillNames:
// figma-use,figma-generate-design
// Target: tM92ylAZ9DonRMdP1vE2Dq, page 0:1.
// Inspect current canvas before resuming; this script is not an idempotent import.
await figma.setCurrentPageAsync(await figma.getNodeByIdAsync('0:1'));
const source = await figma.getNodeByIdAsync('4:81');
const main = await figma.getNodeByIdAsync('4:75');
const title = await figma.getNodeByIdAsync('4:76');
const body = await figma.getNodeByIdAsync('4:77');
const label = await figma.getNodeByIdAsync('4:259');
const footer = await figma.getNodeByIdAsync('4:260');
const fonts = new Map();
for (const text of [...source.findAllWithCriteria({types: ['TEXT']}), title, body, label, footer]) {
  for (const segment of text.getStyledTextSegments(['fontName'])) {
    fonts.set(JSON.stringify(segment.fontName), segment.fontName);
  }
}
await Promise.all([...fonts.values()].map(font => figma.loadFontAsync(font)));
const created = [];
const remember = node => {
  created.push(node.id);
  if ('children' in node) created.push(...node.findAll(() => true).map(child => child.id));
  return node;
};
const addText = (base, content, width, parent) => {
  const node = base.clone();
  node.name = content.slice(0, 40);
  node.characters = content;
  node.textAutoResize = 'HEIGHT';
  node.resize(width, node.height);
  parent.appendChild(node);
  remember(node);
  return node;
};
const board = figma.createAutoLayout('VERTICAL');
board.name = 'AI 学习助手 / 轻快动效规范 0.9.4';
board.resize(1040, 800);
board.primaryAxisSizingMode = 'AUTO';
board.counterAxisSizingMode = 'FIXED';
board.paddingTop = board.paddingBottom = board.paddingLeft = board.paddingRight = 32;
board.itemSpacing = 16;
board.fills = JSON.parse(JSON.stringify(main.fills));
board.cornerRadius = main.cornerRadius;
figma.currentPage.appendChild(board);
board.x = 1500;
board.y = 80;
remember(board);
addText(title, '轻快交互 / 0.9.4', 976, board);
addText(body, '状态立即生效，动效只负责衔接。保留整体玻璃视觉，缩短反馈路径。', 976, board);
const columns = figma.createAutoLayout('HORIZONTAL');
columns.name = '面板示意与实现节奏';
columns.fills = [];
columns.itemSpacing = 28;
columns.resize(976, 620);
columns.primaryAxisSizingMode = 'FIXED';
columns.counterAxisSizingMode = 'AUTO';
columns.counterAxisAlignItems = 'MIN';
board.appendChild(columns);
remember(columns);
const preview = source.clone();
preview.name = '原生可编辑概览 / 动效示意';
columns.appendChild(preview);
preview.resize(432, 620);
preview.layoutSizingHorizontal = preview.layoutSizingVertical = 'FIXED';
preview.clipsContent = true;
remember(preview);
const notes = figma.createAutoLayout('VERTICAL');
notes.name = '动效时长与帧预算';
notes.fills = [];
notes.resize(516, 620);
notes.primaryAxisSizingMode = 'AUTO';
notes.counterAxisSizingMode = 'FIXED';
notes.itemSpacing = 12;
columns.appendChild(notes);
remember(notes);
const sections = [
  ['短距离、即时响应', '展开 160 ms / 收起 100 ms / 页签 140 ms\n位移最多 4 px，透明度 0.8 → 1。\n缓动 cubic-bezier(0.22, 1, 0.36, 1)。'],
  ['拖动直接跟随手势', 'requestAnimationFrame 合并指针事件。\n每帧只更新 transform，不加惯性或缓动。\n松手后提交最终坐标并保存。'],
  ['把渲染留给必要的变化', '交互期间暂停重折射与贴图生成。\n运动结束再恢复细节；隐藏页面停止动效。\n动画只使用 transform 与 opacity。'],
  ['减少动态效果', '遵循系统偏好：80 ms 纯淡入，无位移。\n快速反复操作接续当前状态，不叠加动画。'],
  ['帧预算，不预设测量结论', '60 Hz：每帧约 16.7 ms\n120 Hz：每帧约 8.3 ms\n实际流畅度以浏览器运行测量为准。']
];
for (const [heading, content] of sections) {
  addText(label, heading, 516, notes);
  addText(body, content, 516, notes);
}
const primary = await figma.getNodeByIdAsync('4:65');
const action = primary.createInstance();
notes.appendChild(action);
action.setProperties({'Label#4:0': '动效规范'});
remember(action);
addText(body, '示意沿用现有面板与组件，所有文字和图层保持可编辑。', 976, board);
footer.characters = '展开 160 ms · 收起 100 ms · 页签 140 ms · 最大位移 4 px；减少动态效果时使用 80 ms 纯淡入。';
footer.name = '交互节奏 / 0.9.4';
return {
  createdNodeIds: [...new Set(created)],
  mutatedNodeIds: [footer.id],
  board: {id: board.id, width: board.width, height: board.height, x: board.x, y: board.y},
  previewId: preview.id,
  nativeTextCount: board.findAllWithCriteria({types: ['TEXT']}).length,
  instanceCount: board.findAllWithCriteria({types: ['INSTANCE']}).length
};
