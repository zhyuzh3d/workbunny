'use strict';
// A posture change must be requested of Bunny, not merely mentioned by the owner.
function postureIntent(input) {
  const text = String(input || '').toLowerCase();
  if (/(?:别|不要|不用|不必|无需|别再|不要再)(?:让你|你|再|去|先)?(?:坐下|坐好|坐一会|站起来|站起|起身|站好)/u.test(text)) return null;
  if (/(?:我|主人)(?:刚|正|已经|要|想|又)?(?:坐下|坐好|坐一会|站起来|站起|起身|站好)/u.test(text) && !/(?:让|叫|请|你|可可|bunny)/u.test(text)) return null;
  if (/(?:坐下|坐一会|坐着休息|坐好)/u.test(text)) return 'hq_world_sit_enter';
  if (/(?:站起来|起身|站起|站好)/u.test(text)) return 'hq_world_sit_exit';
  return null;
}
module.exports = { postureIntent };
