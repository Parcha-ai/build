import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from "remotion";
import { SceneTransition } from "../components/SceneTransition";
import { AngledScreen } from "../components/AngledScreen";
import { COLORS } from "../constants";
import {
  GrepChatHeader,
  GrepInputArea,
  GrepBrowserPreview,
  MessageBubble,
} from "../components/grep-ui";
import { MOCK_MESSAGES_AUTH } from "../mocks/mockData";

export const Scene6_BrowserPreview: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Inspector highlight phase
  const inspectorPhase = Math.floor(interpolate(frame, [80, 140, 200], [0, 1, 2], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));

  // Animated spotlight that moves from left panel to right panel
  const spotlightProgress = interpolate(frame, [100, 200], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.25, 0.1, 0.25, 1.0),
  });
  // Spotlight X position moves from left panel area to right panel area
  const spotlightX = interpolate(spotlightProgress, [0, 1], [400, 1500]);
  const spotlightY = 400;
  const spotlightOpacity = interpolate(frame, [90, 110, 190, 220], [0, 0.6, 0.6, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Checkmark animation — snappy pop-in
  const checkSpring = spring({
    frame: frame - 230,
    fps,
    config: { damping: 14, stiffness: 170, mass: 0.8 },
    durationRestThreshold: 0.001,
  });

  // Feature text — gentle entrance
  const textDelay = 50;
  const textSpring = spring({
    frame: frame - textDelay,
    fps,
    config: { damping: 20, stiffness: 80, mass: 1.2 },
    durationRestThreshold: 0.001,
  });
  const textOpacity = interpolate(textSpring, [0, 1], [0, 1]);
  const textY = interpolate(textSpring, [0, 1], [30, 0]);

  // Ambient glow
  const glowPulse = 0.5 + 0.2 * Math.sin(frame * 0.05);

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      <SceneTransition>
        {/* Ambient background */}
        <div
          style={{
            position: 'absolute',
            top: '40%',
            left: '50%',
            width: 1200,
            height: 600,
            transform: 'translate(-50%, -50%)',
            background: `radial-gradient(ellipse, ${COLORS.secondary}06 0%, transparent 70%)`,
            opacity: glowPulse,
            pointerEvents: 'none',
          }}
        />

        {/* Animated spotlight beam connecting the two panels */}
        <div
          style={{
            position: 'absolute',
            left: spotlightX - 150,
            top: spotlightY - 200,
            width: 300,
            height: 400,
            background: `radial-gradient(ellipse, ${COLORS.primary}18 0%, transparent 70%)`,
            opacity: spotlightOpacity,
            pointerEvents: 'none',
            zIndex: 10,
          }}
        />

        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          {/* Two floating panels side by side */}
          <div
            style={{
              display: 'flex',
              gap: 60,
              alignItems: 'center',
            }}
          >
            {/* Panel 1 (left) — Code/Chat Panel */}
            <AngledScreen
              width={650}
              height={600}
              rotateY={8}
              rotateX={2}
              glowColor={COLORS.primary}
              enterDelay={0}
              reflection={false}
            >
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <GrepChatHeader
                  sessionName="Auth refactor"
                  status="running"
                />

                <div style={{ flex: 1, padding: 16, overflow: 'hidden' }}>
                  <div className="space-y-3">
                    {MOCK_MESSAGES_AUTH.slice(0, 2).map((msg, i) => {
                      const msgSpring = spring({
                        frame: frame - 10 - i * 12,
                        fps,
                        config: { damping: 14, stiffness: 170, mass: 0.8 },
                        durationRestThreshold: 0.001,
                      });
                      return (
                        <div
                          key={msg.id}
                          style={{
                            opacity: msgSpring,
                            transform: `translateY(${interpolate(msgSpring, [0, 1], [15, 0])}px)`,
                          }}
                        >
                          <MessageBubble
                            message={msg}
                            isOldMessage={true}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>

                <GrepInputArea
                  permissionMode="acceptEdits"
                  effortLevel="high"
                  modelLabel="Opus 4.6"
                />
              </div>
            </AngledScreen>

            {/* Panel 2 (right) — Browser Preview */}
            <AngledScreen
              width={650}
              height={600}
              rotateY={-10}
              rotateX={2}
              glowColor={COLORS.terminalGreen}
              enterDelay={12}
              reflection={false}
            >
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                {/* Panel header */}
                <div
                  style={{
                    height: 40,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0 12px',
                    borderBottom: '2px solid #2a2a3e',
                    backgroundColor: '#1a1a2e',
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 500, color: COLORS.text, fontFamily: 'Inter, sans-serif' }}>Browser Preview</span>
                  <span style={{ fontSize: 11, color: COLORS.muted, fontFamily: 'JetBrains Mono, monospace' }}>localhost:3000</span>
                </div>

                {/* Browser content */}
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <GrepBrowserPreview url="http://localhost:3000" isInspectorActive={inspectorPhase > 0}>
                    {/* Simulated page with inspector highlights */}
                    <div className="h-full flex flex-col bg-white" style={{ position: 'relative' }}>
                      {/* Header bar */}
                      <div
                        className="h-14 flex items-center px-6"
                        style={{
                          backgroundColor: '#111827',
                          border: inspectorPhase === 0 ? '2px solid #3b82f6' : 'none',
                          boxShadow: inspectorPhase === 0 ? '0 0 12px rgba(59, 130, 246, 0.4)' : 'none',
                        }}
                      >
                        <div className="w-24 h-4 bg-white/20 rounded" />
                        <div className="ml-auto flex gap-4">
                          <div className="w-12 h-3 bg-white/15 rounded" />
                          <div className="w-12 h-3 bg-white/15 rounded" />
                        </div>
                      </div>

                      {/* Content */}
                      <div className="flex-1 p-6 bg-gradient-to-b from-gray-50 to-white">
                        <div className="max-w-md mx-auto space-y-4">
                          <div className="h-6 w-48 bg-gray-200 rounded" />
                          <div className="h-4 w-64 bg-gray-100 rounded" />
                        </div>

                        <div className="flex gap-4 mt-6">
                          {[1, 2, 3].map(i => (
                            <div
                              key={i}
                              className="flex-1 h-28 bg-gray-50 border border-gray-200 rounded-lg p-4"
                              style={{
                                border: inspectorPhase === 1 && i === 2 ? '2px solid #8b5cf6' : '2px solid #e5e7eb',
                                boxShadow: inspectorPhase === 1 && i === 2 ? '0 0 12px rgba(139, 92, 246, 0.4)' : 'none',
                              }}
                            >
                              <div className="w-12 h-3 bg-gray-300 rounded mb-2" />
                              <div className="w-full h-2 bg-gray-200 rounded mb-1" />
                              <div className="w-3/4 h-2 bg-gray-200 rounded" />
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Green checkmark */}
                      {frame > 230 && (
                        <div
                          style={{
                            position: 'absolute',
                            right: 30,
                            top: 80,
                            transform: `scale(${checkSpring})`,
                            width: 40,
                            height: 40,
                            backgroundColor: '#22c55e',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            boxShadow: '0 0 20px rgba(34, 197, 94, 0.5)',
                          }}
                        >
                          <span style={{ color: '#fff', fontSize: 24, fontWeight: 700 }}>{"\u2713"}</span>
                        </div>
                      )}
                    </div>
                  </GrepBrowserPreview>
                </div>
              </div>
            </AngledScreen>
          </div>

          {/* Feature text below panels */}
          <div
            style={{
              position: 'absolute',
              bottom: 60,
              left: 0,
              right: 0,
              textAlign: 'center',
              zIndex: 10,
            }}
          >
            <div
              style={{
                display: 'inline-block',
                padding: '14px 36px',
                backgroundColor: 'rgba(10, 10, 10, 0.85)',
                backdropFilter: 'blur(8px)',
                border: `2px solid ${COLORS.primary}40`,
                opacity: textOpacity,
                transform: `translateY(${textY}px)`,
              }}
            >
              <span
                style={{
                  fontSize: 28,
                  fontFamily: "JetBrains Mono, monospace",
                  fontWeight: 700,
                  color: COLORS.text,
                  letterSpacing: 2,
                }}
              >
                Live browser. DOM inspection. Auto-test.
              </span>
            </div>
          </div>
        </AbsoluteFill>
      </SceneTransition>
    </AbsoluteFill>
  );
};
