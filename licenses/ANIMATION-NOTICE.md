# Animation credits and license scope

These terms apply to the motion data individually, independently of WorkBunny's source-code MIT license. WorkBunny's official distribution is free. No license is granted here for personal imported models or animations.

- **Sachi VRMA 1** — sashii / sachi2222. CC0 1.0. Original declaration: https://booth.pm/ja/items/6412084 . Repository provenance: LongbowXXX/ai-tuber at `3dc9854ee82a1fecc3e9e94c6dc68fa34a115c68`, whose README explicitly identifies the VRMA package. Seven included poses: `idle_pose`, `tease_punch`, `refuse_fear`, `refuse_no`, `greet_sachi`, `praise_sachi`, `sign_sachi`.
- **chatter-agent original motions** — Masaki Matsumura / schwarz9791. CC0 1.0, explicitly dedicated in the upstream NOTICE. Seven included motions: `cheer_arms`, `sorry_droop`, `motion_walk`, `refuse_startle`, `angry_stomp`, `shy_sway`, `think_ultra`. Source: https://github.com/schwarz9791/chatter-agent/tree/e5e5f955e65196833ac2fdbe5a4abaf4a5fb9ac3 ; see `chatter-mascot/Assets/StreamingAssets/NOTICE.txt`.
- **idle_loop** — Copyright 2026 kazakago, CC Mascot, Apache License 2.0. https://github.com/kazakago/cc-mascot . Obtained through chatter-agent, whose NOTICE identifies this exact file and author. No animation keyframes changed.
- **Desktop Homunculus motion assets** — notelm / not-elm, CC-BY-4.0; package additionally declares MIT AND CC-BY-4.0. Three included motions: `work_maid`, `work_sit`, `sorry_grab`. Source: https://github.com/not-elm/desktop-homunculus/tree/30d11a5ad72f97f405117086839acd0ea87e1c49 ; creative-asset scope in README and `mods/assets/package.json`. Attribution and original license remain; no endorsement is implied.

Changes: local semantic filenames; where needed, embedded JSON glTF was converted to GLB and `VRMC_vrm_animation.specVersion` normalized to 1.0. Original animation BIN payload, nodes, accessors, buffer views and animation channels were compared against the pinned upstream files and preserved. Runtime retargeting, cropping and foot grounding are performed by WorkBunny, without rewriting the distributed source motion files.

Full applicable texts: `CC0-1.0.txt`, `CC-BY-4.0.txt`, `Apache-2.0.txt`, `homunculus-MIT.txt`. Detailed file hashes, provenance and per-file decisions are in `resources-manifest.json` and `docs/assets-audit.json`.
