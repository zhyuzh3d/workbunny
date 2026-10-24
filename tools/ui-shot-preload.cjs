
window.pet = {
  init: async () => ({
    config: {
      avatar: '58.vrm',
      buddy: { name: 'baby' },
      llm: { baseURL: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3.5-bolt-e4b', apiKey: '' },
      tts: { enabled: true, baseURL: '', apiKey: '', instructions: '' },
      voice: { enabled: true, alwaysListen: true, device: '' },
      monitor: { speakOnDone: true, speakOnLong: true, speakOnStall: true, speakOnRest: true, minGapMs: 40000 },
      window: { w: 400, h: 620 },
    },
    motions: [],
    avatar: '58.vrm',
    avatars: [{"key":"58.vrm","file":"58.vrm","label":"メープル","author":"有坂みと","vrmVersion":"0.x","redistribute":true},{"key":"AvatarSample_D.vrm","file":"AvatarSample_D.vrm","label":"千駄ヶ谷渋","author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false},{"key":"AvatarSample_E.vrm","file":"AvatarSample_E.vrm","label":"ビビ","author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false},{"key":"AvatarSample_F.vrm","file":"AvatarSample_F.vrm","label":"ヴィータ","author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false},{"key":"AvatarSample_G.vrm","file":"AvatarSample_G.vrm","label":"ヴィクトリア・ルービン","author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false}],
    monitor: null, asrAvailable: true,
    versions: { electron: '', chrome: '' }, paths: { userData: '/tmp' },
  }),
  config: async (p) => p || {}, probe: async () => ({}), log: () => {},
  avatars: async () => [{"key":"58.vrm","file":"58.vrm","label":"メープル","author":"有坂みと","vrmVersion":"0.x","redistribute":true},{"key":"AvatarSample_D.vrm","file":"AvatarSample_D.vrm","label":"千駄ヶ谷渋","author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false},{"key":"AvatarSample_E.vrm","file":"AvatarSample_E.vrm","label":"ビビ","author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false},{"key":"AvatarSample_F.vrm","file":"AvatarSample_F.vrm","label":"ヴィータ","author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false},{"key":"AvatarSample_G.vrm","file":"AvatarSample_G.vrm","label":"ヴィクトリア・ルービン","author":"VRoidプロジェクト","vrmVersion":"0.x","redistribute":false}],
  hit: () => {}, asrStatus: async () => ({ speech: 3, mic: true, note: 'ok' }),
  openPrivacy: () => {}, audioDone: () => {},
  on: (cb) => { window.__emit = (d) => cb(d); },
  send: () => {},
};
