'use strict';
function timeContext(now = Date.now(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const date = new Date(now), fmt = (options, locale = 'zh-CN') => new Intl.DateTimeFormat(locale, { timeZone: timezone, ...options });
  const parts = Object.fromEntries(fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(x => [x.type, x.value]));
  const month = +parts.month, day = +parts.day, hour = +parts.hour;
  const period = hour < 5 ? '凌晨' : hour < 9 ? '早晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';
  const solar = { '1-1': '元旦', '2-14': '情人节', '5-1': '劳动节', '6-1': '儿童节', '10-1': '国庆节', '12-25': '圣诞节' }[`${month}-${day}`];
  let lunarText = '', lunarHoliday = '', lunarMonth = null, lunarDay = null, lunarLeapMonth = false;
  try {
    const lunar = fmt({ year: 'numeric', month: 'long', day: 'numeric' }, 'zh-CN-u-ca-chinese');
    const lp = Object.fromEntries(lunar.formatToParts(date).map(x => [x.type, x.value]));
    lunarText = lunar.format(date);
    const names = { 正月: 1, 二月: 2, 三月: 3, 四月: 4, 五月: 5, 六月: 6, 七月: 7, 八月: 8, 九月: 9, 十月: 10, 冬月: 11, 十一月: 11, 腊月: 12, 十二月: 12 };
    lunarLeapMonth = /^闰/.test(lp.month || ''); lunarMonth = names[String(lp.month || '').replace(/^闰/, '')] || null; lunarDay = +lp.day || null;
    const m = lunarMonth, d = lunarDay;
    if (m && !lunarLeapMonth) lunarHoliday = { '1-1': '春节', '1-15': '元宵节', '5-5': '端午节', '7-7': '七夕', '8-15': '中秋节', '9-9': '重阳节', '12-8': '腊八节' }[`${m}-${d}`] || '';
    // 除夕由下一天是否正月初一判断，兼容大月/小月与闰月，不写死为腊月三十。
    const next = Object.fromEntries(lunar.formatToParts(new Date(now + 86400000)).map(x => [x.type, x.value]));
    if (next.month === '正月' && +next.day === 1) lunarHoliday = '除夕';
  } catch { /* No invented lunar date if ICU lacks the calendar. */ }
  const holiday = [solar, lunarHoliday].filter(Boolean).join('、');
  const isoDay = `${parts.year}-${parts.month}-${parts.day}`;
  return { now, timezone, hour, period, isoDay, monthDay: `${parts.month}-${parts.day}`, month, day, lunarMonth, lunarDay, lunarLeapMonth, holiday, lunar: lunarText,
    line: `当前当地时间：${isoDay} ${fmt({ weekday: 'long' }).format(date)} ${parts.hour}:${parts.minute}:${parts.second}（${timezone}，${period}）。${lunarText ? '农历：' + lunarText + '。' : ''}${holiday ? '今天是' + holiday + '。' : ''}节日只代表历法日期，不代表法定调休或用户一定庆祝。` };
}
function elapsedLabel(ms) {
  if (ms < 0) return '未来';
  if (ms < 60000) return `${Math.floor(ms / 1000)}秒前`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}分钟前`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}小时前`;
  return `${Math.floor(ms / 86400000)}天前`;
}
module.exports = { timeContext, elapsedLabel };
