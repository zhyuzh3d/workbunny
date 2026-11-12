'use strict';
// Appearance is a temporary virtual body, never a replacement personality.
const DESCRIPTIONS = {
  'builtin_soft_bunny': '兔兔：可爱的3D卡通兔子头形象，可以弯曲表达情感动作的长耳朵，黑眼睛。',
  'Bani.vrm': '芭尼：可爱的3D卡通兔女郎形象，成熟女孩体型，圆脸，大眼，玫粉色短发，长长的粉色兔耳，头戴浅粉色小花；穿白色短袖上衣，粉色领口和袖口收边，爱心形粉色小纽扣；穿粉色短热裤；胸前有粉色蝴蝶结。',
  'AvatarSample_D.vrm': '可可：清爽的3D学院风女孩形象，深蓝色齐刘海短发，橙红发夹，棕色眼睛；穿白色短袖衬衫、深蓝针织背心和深色百褶裙，配橙红蝴蝶结、黑色长袜和棕色鞋。',
  'AvatarSample_Shino.vrm': '兰兰：清爽的3D学院风女孩形象，深蓝色齐刘海长发，蓝色发夹，棕色眼睛；穿白色短袖衬衫、深蓝针织背心和深色百褶裙，配亮蓝色蝴蝶结和深色长袜。',
  'AvatarSample_E.vrm': '阿雅：田园风可爱女孩形象，棕色齐刘海短波波头，头顶有一撮翘发，左右两个红色小樱桃造型发绳，青绿色眼睛；穿米白上衣、浅绿色裙装，白色围裙上面有绿色蝴蝶结和小花果装饰，腰间白色腰带，脚穿棕色绑带长靴。',
  'AvatarSample_F.vrm': '琪琪：科幻感冷酷女孩形象，银白短发，蓝绿色尖形发饰，双眼分别呈黄绿色和蓝色；穿黑色长袖上衣与短裙，衣服带亮青绿色几何纹样和白色发光条带，搭配深蓝渐变长袜和厚底鞋。',
  'AvatarSample_G.vrm': '美莉：童话风美丽女孩形象，浅金色侧马尾，绿色发带，蓝色眼睛；穿粉白色长袖裙，配奶油色束腰、胸前粉色蝴蝶结和腰间黑色系带，穿白色长袜和粉色鞋，整体是柔和的童话礼裙风格。',
};

// Match the surface renderer's selected/default palette fallback at read time.
function contextDescription(key, description, runtime, selectedPalette) {
  if (key !== 'builtin_soft_bunny' || !runtime) return description;
  const palettes = runtime.palettes || [];
  const palette = palettes.find(p => p.id === selectedPalette) || palettes.find(p => p.id === runtime.defaultPalette);
  const base = palette?.base || runtime.palette?.base;
  if (!base) return description;
  const color = palette?.label ? `${palette.label}（${base}）` : base;
  return `${description} 当前外观的主体颜色：${color}。`;
}
module.exports = { DESCRIPTIONS, contextDescription };
