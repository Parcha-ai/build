import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from "remotion";
import { AngledScreen } from "../components/AngledScreen";
import { COLORS } from "../constants";
import {
  GrepTerminal,
  GrepGitExplorer,
  GrepExtensionsExplorer,
  GrepInputArea,
  GrepStatusBar,
  GrepBrowserPreview,
  GrepGStackMenu,
} from "../components/grep-ui";
import { MOCK_TERMINAL_OUTPUT, MOCK_GIT_CHANGES } from "../mocks/mockData";

interface FeatureConfig {
  label: string;
  color: string;
  width: number;
  height: number;
  rotateY: number;
  rotateX: number;
  renderContent: (featureFrame: number, fps: number) => React.ReactNode;
}

const features: FeatureConfig[] = [
  {
    label: "Multi-tab Terminal",
    color: "#22c55e",
    width: 850,
    height: 420,
    rotateY: -8,
    rotateX: 5,
    renderContent: (featureFrame, fps) => {
      const visibleLines = Math.floor(interpolate(featureFrame, [5, 45], [0, 15], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      }));
      return (
        <GrepTerminal output={MOCK_TERMINAL_OUTPUT} visibleLines={visibleLines} />
      );
    },
  },
  {
    label: "Git Integration",
    color: "#f59e0b",
    width: 500,
    height: 450,
    rotateY: 12,
    rotateX: 3,
    renderContent: (featureFrame, fps) => (
      <GrepGitExplorer
        branch="aj/auth-refactor"
        changes={MOCK_GIT_CHANGES}
        commitMessage="feat: add JWT refresh token mutex"
      />
    ),
  },
  {
    label: "MCP Extensions",
    color: "#3b82f6",
    width: 440,
    height: 450,
    rotateY: -15,
    rotateX: 4,
    renderContent: (featureFrame, fps) => (
      <GrepExtensionsExplorer />
    ),
  },
  {
    label: "Live Browser Preview",
    color: "#e879f9",
    width: 750,
    height: 450,
    rotateY: 10,
    rotateX: -3,
    renderContent: (featureFrame, fps) => (
      <GrepBrowserPreview url="http://localhost:3000/dashboard" />
    ),
  },
  {
    label: "Model & Mode Switching",
    color: "#8b5cf6",
    width: 720,
    height: 160,
    rotateY: -6,
    rotateX: 6,
    renderContent: (featureFrame, fps) => {
      const modeIndex = Math.floor(featureFrame / 15) % 4;
      const modes: Array<'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'> = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
      const models = ['Opus 4.6', 'Sonnet 4.5', 'Haiku 3.5', 'Opus 4.6'];
      const efforts: Array<'low' | 'medium' | 'high' | 'max'> = ['low', 'medium', 'high', 'max'];

      return (
        <div>
          <GrepInputArea
            permissionMode={modes[modeIndex]}
            effortLevel={efforts[modeIndex]}
            modelLabel={models[modeIndex]}
          />
          <GrepStatusBar
            branch="aj/feature-branch"
            showSubagent={modeIndex === 2}
            subagentType="IMPLEMENT"
          />
        </div>
      );
    },
  },
  {
    label: "Planning Mode",
    color: "#3b82f6",
    width: 720,
    height: 160,
    rotateY: 8,
    rotateX: 4,
    renderContent: (featureFrame, fps) => (
      <div>
        <GrepInputArea
          permissionMode="plan"
          effortLevel="high"
          modelLabel="Opus 4.6"
          inputText="Design the database schema for multi-tenant support"
        />
        <GrepStatusBar
          branch="aj/multi-tenant"
        />
      </div>
    ),
  },
  {
    label: "Subagent Teams",
    color: "#ef4444",
    width: 720,
    height: 160,
    rotateY: -12,
    rotateX: 3,
    renderContent: (featureFrame, fps) => (
      <div>
        <GrepStatusBar
          branch="aj/auth-refactor"
          showSubagent={true}
          subagentType={featureFrame < 30 ? 'EXPLORE' : 'IMPLEMENT'}
        />
        <div
          style={{
            marginTop: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            justifyContent: 'center',
          }}
        >
          {[
            { name: 'bond', color: '#3B82F6' },
            { name: 'q', color: '#8B5CF6' },
            { name: 'moneypenny', color: '#EC4899' },
          ].map(agent => (
            <div key={agent.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 8px',
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'uppercase' as const,
                  fontFamily: 'JetBrains Mono, monospace',
                  color: agent.color,
                  backgroundColor: `${agent.color}15`,
                  border: `2px solid ${agent.color}40`,
                  letterSpacing: '0.08em',
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: agent.color,
                  }}
                />
                {agent.name}
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
  },
];

const FRAMES_PER_FEATURE = 60;

export const Scene9_SpeedMontage: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const currentFeatureIndex = Math.min(
    Math.floor(frame / FRAMES_PER_FEATURE),
    features.length - 1
  );
  const featureFrame = frame - currentFeatureIndex * FRAMES_PER_FEATURE;

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      {features.map((feature, i) => {
        const isActive = i === currentFeatureIndex;
        if (!isActive) return null;

        const exitOpacity = interpolate(
          featureFrame,
          [FRAMES_PER_FEATURE - 8, FRAMES_PER_FEATURE],
          [1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.25, 0.1, 0.25, 1.0) }
        );

        // Label spring — gentle entrance
        const labelSpring = spring({
          frame: featureFrame - 5,
          fps,
          config: { damping: 20, stiffness: 80, mass: 1.2 },
          durationRestThreshold: 0.001,
        });

        // Ambient glow behind the panel
        const glowPulse = 0.4 + 0.3 * Math.sin(featureFrame * 0.1);

        return (
          <AbsoluteFill
            key={feature.label}
            style={{
              justifyContent: "center",
              alignItems: "center",
              opacity: exitOpacity,
              flexDirection: "column",
              gap: 32,
            }}
          >
            {/* Ambient glow */}
            <div
              style={{
                position: 'absolute',
                top: '45%',
                left: '50%',
                width: 600,
                height: 400,
                transform: 'translate(-50%, -50%)',
                background: `radial-gradient(ellipse, ${feature.color}10 0%, transparent 70%)`,
                opacity: glowPulse,
                pointerEvents: 'none',
              }}
            />

            {/* Feature panel in AngledScreen */}
            <AngledScreen
              width={feature.width}
              height={feature.height}
              rotateY={feature.rotateY}
              rotateX={feature.rotateX}
              glowColor={feature.color}
              glowIntensity={0.8}
              enterDelay={0}
              reflection={false}
            >
              {feature.renderContent(featureFrame, fps)}
            </AngledScreen>

            {/* Label */}
            <div
              style={{
                fontSize: 36,
                fontFamily: "Inter, sans-serif",
                fontWeight: 700,
                color: COLORS.text,
                transform: `translateY(${interpolate(labelSpring, [0, 1], [25, 0])}px)`,
                opacity: labelSpring,
                letterSpacing: 1,
              }}
            >
              {feature.label}
            </div>

            {/* Progress dots */}
            <div style={{ display: "flex", gap: 10 }}>
              {features.map((_, j) => {
                const dotScale = j === i ? 1 : 0.8;
                return (
                  <div
                    key={j}
                    style={{
                      width: j === i ? 24 : 8,
                      height: 8,
                      backgroundColor: j === i ? feature.color : `${COLORS.muted}40`,
                      transform: `scale(${dotScale})`,
                      boxShadow: j === i ? `0 0 12px ${feature.color}60` : 'none',
                    }}
                  />
                );
              })}
            </div>
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
};
