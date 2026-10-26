'use strict';

const KEY_NAME = 'user.name';
const KEY_BIRTHDAY = 'user.birthday';
const EN_MONTHS = Object.freeze({
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
});
const QUOTES = /["“”‘’「」『』《》〈〉]/u;
const UNSAFE_CLAIM = /(?:不(?:是|叫|为|會|会|想|要|用|必)|不是|并非|没(?:有)?|假如|如果|假设|比如|例如|听说|他说|她说|他们说|don't|do\s+not|didn't|doesn't|isn't|aren't|wasn't|weren't|never|\bnot\b|suppose|imagine|maybe|perhaps)/iu;

function cleanText(text) {
  if (typeof text !== 'string' || text.length > 1000) return null;
  const value = text.normalize('NFKC').trim();
  if (!value || /[?？]/u.test(value) || QUOTES.test(value) || (value.match(/'/gu) || []).length >= 2 || UNSAFE_CLAIM.test(value)) return null;
  return value;
}

function normalizeName(value) {
  if (typeof value !== 'string') return '';
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name || name.length > 80 || !/^[\p{L}\p{M}]+(?:[ \t]+[\p{L}\p{M}]+|['’.-][\p{L}\p{M}]+|·[\p{L}\p{M}]+)*$/u.test(name)) return '';
  if (/^(?:什么|啥|谁|哪位|某某|某人|未知|未定|我|你|他|她|name|someone|unknown)$/iu.test(name)) return '';
  return name.toLocaleLowerCase('en-US');
}

function validDate(month, day, calendar, year) {
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1) return false;
  if (calendar === 'lunar') return day <= 30;
  if (calendar !== 'solar') return false;
  if (Number.isInteger(year)) {
    if (year < 1 || year > 9999) return false;
    const days = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= days[month - 1];
  }
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function birthdayFact(monthValue, dayValue, calendar = 'solar', yearValue) {
  const month = Number(monthValue), day = Number(dayValue);
  const year = yearValue === undefined || yearValue === '' ? undefined : Number(yearValue);
  if (!validDate(month, day, calendar, year)) return null;
  return { key: KEY_BIRTHDAY, canonicalValue: `${calendar}:${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    memoryKind: 'anniversary', anniversary: { calendar, month, day } };
}

function parseChineseBirthday(body) {
  const text = body.replace(/[。.!！,，;；:：]+$/u, '').trim();
  let calendar = 'solar';
  let value = text;
  if (/^(?:农历|阴历)/u.test(value)) { calendar = 'lunar'; value = value.replace(/^(?:农历|阴历)\s*/u, ''); }
  else if (/^(?:公历|阳历)/u.test(value)) value = value.replace(/^(?:公历|阳历)\s*/u, '');
  const match = value.match(/^(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)$/u);
  return match ? birthdayFact(match[2], match[3], calendar, match[1]) : null;
}

function parseNumericBirthday(body, calendar) {
  const text = body.replace(/[。.!！,，;；:：]+$/u, '').trim();
  let match = text.match(/^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})$/u);
  if (match) return birthdayFact(match[2], match[3], calendar, match[1]);
  match = text.match(/^(\d{1,2})\s*[-/.]\s*(\d{1,2})(?:\s*[-/.]\s*(\d{4}))?$/u);
  if (match) return birthdayFact(match[1], match[2], calendar, match[3]);
  return null;
}

function parseEnglishBirthday(body, calendar) {
  const text = body.replace(/[.!]+$/u, '').trim();
  const numeric = parseNumericBirthday(text, calendar);
  if (numeric) return numeric;
  const monthNames = Object.keys(EN_MONTHS).sort((a, b) => b.length - a.length).join('|');
  let match = text.match(new RegExp(`^(?:(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?|(?<day>\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})(?:,?\\s+(?<year>\\d{4}))?)$`, 'iu'));
  if (!match) return null;
  const monthWord = (match[1] || match[4]).toLowerCase();
  const month = EN_MONTHS[monthWord];
  return birthdayFact(month, match[2] || match.groups?.day, calendar, match[3] || match.groups?.year);
}

function factFromStatement(input) {
  const text = cleanText(input);
  if (!text) return null;

  const nameMatch = text.match(/^(?:我叫|我的名字是|以后叫我)\s*(.+)$/u) ||
    text.match(/^(?:my\s+name\s+is|call\s+me)\s+(.+)$/iu);
  if (nameMatch) {
    const displayName = nameMatch[1].replace(/[。.!！,，;；:：]+$/u, '').trim();
    const canonicalValue = normalizeName(displayName);
    return canonicalValue ? { key: KEY_NAME, canonicalValue, memoryKind: 'fact' } : null;
  }

  const birthdayClaim = text.match(/^我(?:的)?(?:(农历|阴历|公历|阳历))?生日(?:是|为)?\s*(.+)$/u);
  const chineseBirthday = birthdayClaim ? [birthdayClaim[0], `${birthdayClaim[1] || ''}${birthdayClaim[2]}`] :
    text.match(/^我出生于\s*(.+)$/u);
  if (chineseBirthday) {
    let body = chineseBirthday[1].trim();
    // A calendar marker may also follow the birthday copula.
    const marker = body.match(/^(农历|阴历|公历|阳历)\s*(.+)$/u);
    if (marker) body = `${marker[1].replace('阴历', '农历').replace('公历', '阳历')}${marker[2]}`;
    const fact = parseChineseBirthday(body);
    if (fact) return fact;
  }

  const englishBirthday = text.match(/^(?:my\s+(?:(lunar|solar)\s+)?birthday\s+is|i\s+was\s+born\s+on)\s+(.+)$/iu);
  if (englishBirthday) {
    const calendar = /^lunar$/iu.test(englishBirthday[1] || '') ? 'lunar' : 'solar';
    const body = englishBirthday[2].replace(/^(?:lunar|solar)\s+/iu, '');
    return parseEnglishBirthday(body, calendar);
  }
  return null;
}

function factFromMemory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const key = value.key;
  if (key !== undefined && key !== '' && key !== KEY_NAME && key !== KEY_BIRTHDAY) return null;
  if (!key) {
    const parsed = factFromStatement(value.evidence) || factFromStatement(value.content);
    return parsed || null;
  }
  if (typeof value.canonicalValue === 'string') {
    if (key === KEY_NAME) {
      const canonicalValue = normalizeName(value.canonicalValue);
      if (canonicalValue) return { key, canonicalValue, memoryKind: value.memoryKind || 'fact' };
    } else {
      const match = value.canonicalValue.match(/^(solar|lunar):(\d{2})-(\d{2})$/u);
      if (match) {
        const fact = birthdayFact(match[2], match[3], match[1]);
        if (fact) return fact;
      }
    }
  }
  if (key === KEY_BIRTHDAY && value.anniversary && typeof value.anniversary === 'object') {
    const fact = birthdayFact(value.anniversary.month, value.anniversary.day, value.anniversary.calendar);
    if (fact) return fact;
  }
  for (const candidate of [value.evidence, value.content]) {
    const parsed = factFromStatement(candidate);
    if (parsed?.key === key) return parsed;
  }
  return null;
}

function compactQuestion(text) {
  if (typeof text !== 'string' || text.length > 2000) return '';
  return text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\s\p{P}\p{S}]/gu, '');
}

function keysForQuestion(input) {
  const keys = [];
  if (typeof input !== 'string' || input.length > 2000 || QUOTES.test(input)) return keys;
  const parts = input.normalize('NFKC').toLocaleLowerCase('en-US')
    .split(/[。！？?!;；\n]+|\s+and\s+|(?:以及|还有)/u).map(compactQuestion).filter(Boolean);
  for (const text of parts) {
    const name = /^(?:(?:你)?(?:还)?(?:记得|知道))?我(?:的)?(?:名字|姓名)(?:(?:是|叫)?(?:什么|啥)|(?:吗|呢))$/u.test(text) ||
      /^(?:(?:你)?(?:还)?(?:记得|知道))?我叫(?:什么|啥)(?:名字)?(?:吗|呢)?$/u.test(text) ||
      /^(?:what(?:is|s)myname|doyouremembermyname|whatdoyoucallme|whatismyfullname)$/u.test(text) ||
      /^(?:你)?(?:还)?(?:记得|知道)我叫什么(?:名字)?(?:吗|呢)$/u.test(text);
    const birthday = /^(?:(?:你)?(?:还)?(?:记得|知道))?我(?:的)?生日(?:(?:(?:是|在)?(?:哪天|什么时候|几月几日|几月几号|几号|什么日期)(?:吗|呢)?)|(?:吗|呢))$/u.test(text) ||
      /^(?:你)?(?:还)?(?:记得|知道)我生日(?:吗|呢)$/u.test(text) ||
      /^(?:whenismybirthday|whatsmybirthday|doyouremembermybirthday|whatismydateofbirth|whenwasiborn)$/u.test(text) ||
      /^我(?:哪天|什么时候)(?:过)?生日$/u.test(text);
    if (name && !keys.includes(KEY_NAME)) keys.push(KEY_NAME);
    if (birthday && !keys.includes(KEY_BIRTHDAY)) keys.push(KEY_BIRTHDAY);
  }
  return keys.slice(0, 2);
}

module.exports = { factFromStatement, factFromMemory, keysForQuestion };
