import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { Scene1_Hook } from "./scenes/Scene1_Hook";
import { Scene2_PainPoint } from "./scenes/Scene2_PainPoint";
import { Scene3_LogoReveal } from "./scenes/Scene3_LogoReveal";
import { Scene4_MultiSession } from "./scenes/Scene4_MultiSession";
import { Scene5_VoiceMode } from "./scenes/Scene5_VoiceMode";
import { Scene6_BrowserPreview } from "./scenes/Scene6_BrowserPreview";
import { Scene7_SSHTeleport } from "./scenes/Scene7_SSHTeleport";
import { Scene8_ExtendedThinking } from "./scenes/Scene8_ExtendedThinking";
import { Scene9_SpeedMontage } from "./scenes/Scene9_SpeedMontage";
import { Scene10_CTA } from "./scenes/Scene10_CTA";
import { SCENE_DURATIONS, COLORS } from "./constants";

// Narrative order: big features first, build to GStack climax, end with JUST BUILD IT
const SCENE_ORDER: Array<{ component: React.FC; duration: number }> = [
  { component: Scene1_Hook, duration: SCENE_DURATIONS.hook },                   // 1. Terminal boot
  { component: Scene2_PainPoint, duration: SCENE_DURATIONS.painPoint },         // 2. Context switching chaos
  { component: Scene3_LogoReveal, duration: SCENE_DURATIONS.logoReveal },       // 3. GBUILD ASCII reveal
  { component: Scene4_MultiSession, duration: SCENE_DURATIONS.multiSession },   // 4. Multi-session + worktree + forks
  { component: Scene7_SSHTeleport, duration: SCENE_DURATIONS.sshTeleport },     // 5. SSH into remote dev boxes
  { component: Scene6_BrowserPreview, duration: SCENE_DURATIONS.browserPreview }, // 6. Browser inspector
  { component: Scene9_SpeedMontage, duration: SCENE_DURATIONS.speedMontage },   // 7. Git, MCP, terminal, modes, subagents
  { component: Scene5_VoiceMode, duration: SCENE_DURATIONS.voiceMode },         // 8. GStack CEO demo (the hero)
  { component: Scene8_ExtendedThinking, duration: SCENE_DURATIONS.extendedThinking }, // 9. CEO thinking deep dive
  { component: Scene10_CTA, duration: SCENE_DURATIONS.cta },                   // 10. >>> JUST BUILD IT
];

export const HypeReel: React.FC = () => {
  // Calculate cumulative offsets from the ordered scenes
  const offsets = SCENE_ORDER.reduce<number[]>((acc, scene, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + SCENE_ORDER[i - 1].duration);
    return acc;
  }, []);

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      {SCENE_ORDER.map((scene, i) => (
        <Sequence
          key={i}
          from={offsets[i]}
          durationInFrames={scene.duration}
        >
          <scene.component />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
