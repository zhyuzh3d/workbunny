
window.pet = {
  init: async () => ({
    config: {
      avatar: '58.vrm',
      buddy: { name: 'baby' },
      llm: { baseURL: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3.5-bolt-e4b', apiKey: '' },
      tts: { enabled: true, baseURL: '', apiKey: '', instructions: '' },
      voice: { enabled: true, alwaysListen: true, device: '' },
      monitor: { speakOnDone: true, speakOnLong: true, speakOnStall: true, speakOnRest: true, minGapMs: 40000 },
      window: { w: 400, h: 620, scale: 1 },
    },
    motions: [{"key":"idle_loop","label":"待机呼吸","group":"idle","loop":true,"tag":"llm","use":"默认待机，什么都不说时用"},{"key":"LookAround","label":"四处张望","group":"idle","loop":true,"tag":"llm","use":"好奇、找东西、等回应"},{"key":"Relax","label":"放松","group":"idle","loop":true,"tag":"llm","use":"闲下来、陪伴、无事发生"},{"key":"Thinking","label":"思考","group":"idle","loop":true,"tag":"llm","use":"正在想、正在查、不确定"},{"key":"Sleepy","label":"困了","group":"idle","loop":true,"tag":"llm","use":"主人很久没理我、深夜"},{"key":"idle-maid","label":"安静站姿","group":"idle","loop":true,"tag":"event","use":"主人在专注干活时的待机"},{"key":"idle-sitting","label":"并腿站姿","group":"idle","loop":true,"tag":"off","use":"不接入待机：并腿会把裙子顶穿，只能手动看"},{"key":"greeting2","label":"抬手打招呼","group":"greet","loop":false,"tag":"llm","use":"主人刚回来、早安、轻一点的招呼（比 Goodbye 含蓄）"},{"key":"greeting","label":"起身迎接","group":"greet","loop":false,"tag":"event","use":"主人离开很久回来时的正式迎接（从蹲姿站起来挥手）"},{"key":"Goodbye","label":"挥手再见","group":"greet","loop":false,"tag":"llm","use":"打招呼、告别、任务交付"},{"key":"shoot","label":"举手致意","group":"greet","loop":false,"tag":"event","use":"招呼主人过来看"},{"key":"hello","label":"伸懒腰","group":"greet","loop":false,"tag":"llm","use":"坐太久、催主人起来动一动、刚睡醒"},{"key":"Surprised","label":"惊讶","group":"emo","loop":false,"tag":"llm","use":"意外、发现问题、惊讶"},{"key":"Angry","label":"生气","group":"emo","loop":false,"tag":"llm","use":"被亏待、抱怨（仅玩笑级别）"},{"key":"Sad","label":"难过","group":"emo","loop":false,"tag":"llm","use":"抱歉、失败、遗憾"},{"key":"Blush","label":"害羞","group":"emo","loop":false,"tag":"llm","use":"被夸、被感谢"},{"key":"grabbed","label":"低头认错","group":"emo","loop":false,"tag":"llm","use":"抱歉、认错、被主人说了一句（整个人弯下去低头）"},{"key":"Clapping","label":"鼓掌","group":"cheer","loop":false,"tag":"llm","use":"称赞、成功、恭喜"},{"key":"Jump","label":"跳一下","group":"cheer","loop":false,"tag":"llm","use":"好消息、兴奋、提醒主人"},{"key":"spin","label":"转圈庆祝","group":"cheer","loop":false,"tag":"llm","use":"大成功、被夸到飞起"},{"key":"peace_sign","label":"比耶","group":"cheer","loop":false,"tag":"llm","use":"得意、办成了、卖萌"},{"key":"model_pose","label":"摆拍","group":"pose","loop":false,"tag":"event","use":"被盯着看时的摆姿势"},{"key":"motion_pose","label":"迈步走近","group":"pose","loop":false,"tag":"event","use":"走过去看看"},{"key":"show_full_body","label":"展示自己","group":"pose","loop":false,"tag":"llm","use":"被问长什么样、被问是什么"},{"key":"VRMA_07","label":"扶脸","group":"pose","loop":false,"tag":"event","use":"害羞、整理仪表"}],
    motionGroups: [{"id":"idle","label":"待机"},{"id":"greet","label":"打招呼"},{"id":"emo","label":"情绪"},{"id":"cheer","label":"庆祝"},{"id":"pose","label":"姿态"}],
    avatar: '58.vrm',
    avatars: [{"key":"58.vrm","file":"58.vrm","label":"小枫","title":"メープル","light":1,"author":"有坂みと","vrmVersion":"0.x","redistribute":true},{"key":"AvatarSample_D.vrm","file":"AvatarSample_D.vrm","label":"阿凛","title":"千駄ヶ谷渋","light":1,"author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false},{"key":"AvatarSample_E.vrm","file":"AvatarSample_E.vrm","label":"可可","title":"ビビ","light":1,"author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false},{"key":"AvatarSample_F.vrm","file":"AvatarSample_F.vrm","label":"小南","title":"ヴィータ","light":1,"author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false},{"key":"AvatarSample_G.vrm","file":"AvatarSample_G.vrm","label":"薇琪","title":"ヴィクトリア・ルービン","light":0.76,"author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false}],
    monitor: null, asrAvailable: true,
    versions: { electron: '', chrome: '' }, paths: { userData: '/tmp' },
  }),
  config: async (p) => p || {}, probe: async () => ({}), log: () => {},
  avatars: async () => [{"key":"58.vrm","file":"58.vrm","label":"小枫","title":"メープル","light":1,"author":"有坂みと","vrmVersion":"0.x","redistribute":true},{"key":"AvatarSample_D.vrm","file":"AvatarSample_D.vrm","label":"阿凛","title":"千駄ヶ谷渋","light":1,"author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false},{"key":"AvatarSample_E.vrm","file":"AvatarSample_E.vrm","label":"可可","title":"ビビ","light":1,"author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false},{"key":"AvatarSample_F.vrm","file":"AvatarSample_F.vrm","label":"小南","title":"ヴィータ","light":1,"author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false},{"key":"AvatarSample_G.vrm","file":"AvatarSample_G.vrm","label":"薇琪","title":"ヴィクトリア・ルービン","light":0.76,"author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false}],
  scale: async (k) => { window.__scaleAsked = k; return { scale: k }; },
  hit: () => {}, asrStatus: async () => ({ speech: 3, mic: true, note: 'ok' }),
  openPrivacy: () => {}, audioDone: () => {},
  on: (cb) => { window.__emit = (d) => cb(d); },
  send: () => {},
};
