import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from "remotion";
import { SceneTransition } from "../components/SceneTransition";
import { TextReveal } from "../components/TextReveal";
import { Particles } from "../components/Particles";
import { COLORS } from "../constants";

export const Scene7_SSHTeleport: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Connection beam animation
  const beamProgress = interpolate(frame, [30, 90], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.25, 0.1, 0.25, 1.0),
  });

  // Server appears — snappy pop-in
  const serverSpring = spring({
    frame: frame - 60,
    fps,
    config: { damping: 14, stiffness: 170, mass: 0.8 },
    durationRestThreshold: 0.001,
  });

  // Terminal content typing
  const terminalText = "$ ssh deploy@prod-server-01\nConnecting...\nWelcome to prod-server-01\n$ kubectl get pods\nNAME                    READY   STATUS\napi-7d4f8b-x2k9p       1/1     Running\nworker-3c5e1a-m8n2q    1/1     Running\nredis-master-0          1/1     Running";
  const visibleChars = Math.floor(interpolate(frame, [100, 200], [0, terminalText.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      <SceneTransition>
        <Particles count={20} color={COLORS.secondary} />

        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            gap: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 80, marginBottom: 40 }}>
            {/* Local machine */}
            <div
              style={{
                width: 160,
                height: 160,
                borderRadius: 24,
                backgroundColor: COLORS.surface,
                border: `2px solid ${COLORS.primary}40`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                boxShadow: `0 0 30px ${COLORS.primary}20`,
              }}
            >
              <span style={{ fontSize: 48 }}>{"\u{1F4BB}"}</span>
              <span style={{ color: COLORS.muted, fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}>Local</span>
            </div>

            {/* Connection beam */}
            <div style={{ position: "relative", width: 300, height: 4 }}>
              <div
                style={{
                  position: "absolute",
                  height: 4,
                  width: `${beamProgress * 100}%`,
                  background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.secondary})`,
                  borderRadius: 2,
                  boxShadow: `0 0 20px ${COLORS.primary}60`,
                }}
              />
              {/* Traveling dot */}
              <div
                style={{
                  position: "absolute",
                  left: `${beamProgress * 100}%`,
                  top: -6,
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  backgroundColor: COLORS.primary,
                  boxShadow: `0 0 20px ${COLORS.primary}`,
                  opacity: beamProgress > 0 && beamProgress < 1 ? 1 : 0,
                  transform: "translateX(-50%)",
                }}
              />
            </div>

            {/* Remote server */}
            <div
              style={{
                width: 160,
                height: 160,
                borderRadius: 24,
                backgroundColor: COLORS.surface,
                border: `2px solid ${COLORS.secondary}40`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                transform: `scale(${serverSpring})`,
                opacity: serverSpring,
                boxShadow: `0 0 30px ${COLORS.secondary}20`,
              }}
            >
              <span style={{ fontSize: 48 }}>{"\u{1F5A5}\uFE0F"}</span>
              <span style={{ color: COLORS.muted, fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}>Remote</span>
            </div>
          </div>

          {/* Terminal output */}
          <div
            style={{
              width: 700,
              backgroundColor: "#0d1117",
              borderRadius: 12,
              border: `2px solid ${COLORS.muted}20`,
              padding: 20,
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 16,
              fontWeight: 500,
              color: "#22c55e",
              whiteSpace: "pre-wrap",
              lineHeight: 1.6,
              minHeight: 180,
            }}
          >
            {terminalText.slice(0, visibleChars)}
            {visibleChars < terminalText.length && (
              <span
                style={{
                  backgroundColor: "#22c55e",
                  color: "#0d1117",
                  opacity: Math.sin(frame * 0.2) > 0 ? 1 : 0,
                }}
              >
                {" "}
              </span>
            )}
          </div>

          {/* Title */}
          <div style={{ marginTop: 30 }}>
            <TextReveal text="Teleport to any server" delay={50} fontSize={44} />
          </div>
        </AbsoluteFill>
      </SceneTransition>
    </AbsoluteFill>
  );
};
