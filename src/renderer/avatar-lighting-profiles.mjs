// Approved in the lighting workbench, revision 6.
// Intensities already include the original model scale. Apply at scale 1.
import {normalizeLighting,modelLighting} from './avatar-lighting.mjs';

export const AVATAR_LIGHTING_PROFILES = {
  "AvatarSample_D.vrm": {
    "version": 1,
    "multiplier": 0.9,
    "toneMapping": "none",
    "exposure": 1,
    "ambient": {
      "enabled": true,
      "color": "#ffffff",
      "intensity": 1.55
    },
    "hemisphere": {
      "enabled": false,
      "color": "#e3edff",
      "groundColor": "#716657",
      "intensity": 0.5
    },
    "lights": {
      "key": {
        "type": "directional",
        "enabled": true,
        "color": "#ffe3cc",
        "intensity": 3.15,
        "position": [
          1.45,
          2.65,
          2.2
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      },
      "fill": {
        "type": "directional",
        "enabled": true,
        "color": "#ffffff",
        "intensity": 0.5,
        "position": [
          0,
          0.6,
          3
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      },
      "rim": {
        "type": "directional",
        "enabled": true,
        "color": "#bcc8ff",
        "intensity": 1.15,
        "position": [
          -1.6,
          1.7,
          -1.6
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      },
      "top": {
        "type": "directional",
        "enabled": false,
        "color": "#ffffff",
        "intensity": 0.8,
        "position": [
          0,
          3,
          0
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      }
    },
    "shadows": {
      "enabled": false,
      "mapSize": 1024,
      "bias": -0.0003,
      "normalBias": 0.02
    },
    "material": {
      "emissive": 1,
      "toony": null,
      "shift": null,
      "gi": null
    }
  },
  "AvatarSample_E.vrm": {
    "version": 1,
    "multiplier": 1,
    "toneMapping": "none",
    "exposure": 1,
    "ambient": {
      "enabled": true,
      "color": "#e1e0ff",
      "intensity": 2.21
    },
    "hemisphere": {
      "enabled": false,
      "color": "#e3edff",
      "groundColor": "#716657",
      "intensity": 0.31
    },
    "lights": {
      "key": {
        "type": "directional",
        "enabled": true,
        "color": "#ffeedb",
        "intensity": 1.86,
        "position": [
          1.1,
          2.6,
          2.2
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      },
      "fill": {
        "type": "directional",
        "enabled": true,
        "color": "#ffffff",
        "intensity": 0.31,
        "position": [
          0,
          0.6,
          3
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      },
      "rim": {
        "type": "directional",
        "enabled": true,
        "color": "#bcc8ff",
        "intensity": 0.713,
        "position": [
          -1.6,
          1.7,
          -1.6
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      },
      "top": {
        "type": "directional",
        "enabled": false,
        "color": "#ffffff",
        "intensity": 0.496,
        "position": [
          0,
          3,
          0
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      }
    },
    "shadows": {
      "enabled": false,
      "mapSize": 1024,
      "bias": -0.0003,
      "normalBias": 0.02
    },
    "material": {
      "emissive": 1,
      "toony": null,
      "shift": null,
      "gi": null
    }
  },
  "AvatarSample_F.vrm": {
    "version": 1,
    "multiplier": 1.01,
    "toneMapping": "none",
    "exposure": 1,
    "ambient": {
      "enabled": true,
      "color": "#97daf7",
      "intensity": 2.32
    },
    "hemisphere": {
      "enabled": false,
      "color": "#f0f5ff",
      "groundColor": "#716657",
      "intensity": 3.4
    },
    "lights": {
      "key": {
        "type": "directional",
        "enabled": true,
        "color": "#fff6ec",
        "intensity": 4.04,
        "position": [
          4.4,
          -5.2,
          5.45
        ],
        "target": [
          -0.25,
          1.1,
          -0.5
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      },
      "fill": {
        "type": "directional",
        "enabled": true,
        "color": "#ffffff",
        "intensity": 0.32,
        "position": [
          0,
          0.6,
          3
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      },
      "rim": {
        "type": "directional",
        "enabled": true,
        "color": "#bcc8ff",
        "intensity": 0.736,
        "position": [
          -1.6,
          1.7,
          -1.6
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      },
      "top": {
        "type": "directional",
        "enabled": false,
        "color": "#ffffff",
        "intensity": 0.512,
        "position": [
          0,
          3,
          0
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      }
    },
    "shadows": {
      "enabled": false,
      "mapSize": 1024,
      "bias": -0.0003,
      "normalBias": 0.02
    },
    "material": {
      "emissive": 1,
      "toony": null,
      "shift": null,
      "gi": null
    }
  },
  "AvatarSample_G.vrm": {
    "version": 1,
    "multiplier": 1,
    "toneMapping": "none",
    "exposure": 1,
    "ambient": {
      "enabled": true,
      "color": "#ffffff",
      "intensity": 1.064
    },
    "hemisphere": {
      "enabled": false,
      "color": "#e3edff",
      "groundColor": "#716657",
      "intensity": 0
    },
    "lights": {
      "key": {
        "type": "directional",
        "enabled": true,
        "color": "#fff6ec",
        "intensity": 1.86,
        "position": [
          1.1,
          2.6,
          2.2
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      },
      "fill": {
        "type": "directional",
        "enabled": true,
        "color": "#ffffff",
        "intensity": 0.28,
        "position": [
          0,
          0.6,
          3
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      },
      "rim": {
        "type": "directional",
        "enabled": true,
        "color": "#bcc8ff",
        "intensity": 0.644,
        "position": [
          -1.6,
          1.7,
          -1.6
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      },
      "top": {
        "type": "directional",
        "enabled": false,
        "color": "#ffffff",
        "intensity": 0.44800000000000006,
        "position": [
          0,
          3,
          0
        ],
        "target": [
          0,
          0,
          0
        ],
        "distance": 0,
        "decay": 2,
        "angle": 45,
        "penumbra": 0.35
      }
    },
    "shadows": {
      "enabled": false,
      "mapSize": 1024,
      "bias": -0.0003,
      "normalBias": 0.02
    },
    "material": {
      "emissive": 1,
      "toony": null,
      "shift": null,
      "gi": null
    }
  }
};

export function lightingForAvatar(key, fallbackScale=1) {
  return Object.hasOwn(AVATAR_LIGHTING_PROFILES,key)
    ? normalizeLighting(AVATAR_LIGHTING_PROFILES[key])
    : modelLighting(fallbackScale);
}
