import React from "react";
import { useCurrentFrame, interpolate, spring, useVideoConfig, Easing } from "remotion";
import { COLORS } from "../constants";

interface AngledScreenProps {
  children: React.ReactNode;
  width?: number;
  height?: number;
  rotateY?: number;
  rotateX?: number;
  perspective?: number;
  glowColor?: string;
  glowIntensity?: number;
  enterDelay?: number;
  reflection?: boolean;
  spotlightX?: number;
  spotlightY?: number;
}

export const AngledScreen: React.FC<AngledScreenProps> = ({
  children,
  width = 1400,
  height = 800,
  rotateY = -12,
  rotateX = 4,
  perspective = 1200,
  glowColor = COLORS.primary,
  glowIntensity = 0.6,
  enterDelay = 0,
  reflection = true,
  spotlightX,
  spotlightY,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Entrance animation — Apple-style smooth, no bounce
  const enterSpring = spring({
    frame: frame - enterDelay,
    fps,
    config: { damping: 200, stiffness: 100, overshootClamping: true },
    durationRestThreshold: 0.001,
  });

  const enterScale = interpolate(enterSpring, [0, 1], [0.85, 1]);
  const enterOpacity = interpolate(enterSpring, [0, 1], [0, 1]);
  const enterRotateY = interpolate(enterSpring, [0, 1], [rotateY - 10, rotateY]);

  // Subtle floating animation
  const floatY = Math.sin(frame * 0.03) * 3;

  // Glow pulse
  const glowPulse = 0.7 + 0.3 * Math.sin(frame * 0.08);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        transform: `translateY(${floatY}px)`,
      }}
    >
      {/* Main screen */}
      <div
        style={{
          width,
          height,
          transform: `perspective(${perspective}px) rotateY(${enterRotateY}deg) rotateX(${rotateX}deg) scale(${enterScale})`,
          opacity: enterOpacity,
          position: "relative",
          transformStyle: "preserve-3d",
        }}
      >
        {/* Glow border */}
        <div
          style={{
            position: "absolute",
            inset: -2,
            border: `2px solid ${glowColor}40`,
            boxShadow: `
              0 0 ${30 * glowPulse * glowIntensity}px ${glowColor}15,
              0 0 ${60 * glowPulse * glowIntensity}px ${glowColor}08,
              inset 0 0 ${20 * glowPulse * glowIntensity}px ${glowColor}05
            `,
            zIndex: 1,
            pointerEvents: "none",
          }}
        />

        {/* Spotlight highlight */}
        {spotlightX !== undefined && spotlightY !== undefined && (
          <div
            style={{
              position: "absolute",
              left: spotlightX - 100,
              top: spotlightY - 100,
              width: 200,
              height: 200,
              background: `radial-gradient(circle, ${glowColor}20 0%, transparent 70%)`,
              zIndex: 2,
              pointerEvents: "none",
            }}
          />
        )}

        {/* Screen content */}
        <div
          style={{
            width: "100%",
            height: "100%",
            overflow: "hidden",
            backgroundColor: "#1a1a1a",
            position: "relative",
          }}
        >
          {children}
        </div>

        {/* Edge highlight - top */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background: `linear-gradient(90deg, transparent, ${glowColor}30, transparent)`,
            zIndex: 3,
          }}
        />

        {/* Edge highlight - left */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            bottom: 0,
            width: 2,
            background: `linear-gradient(180deg, ${glowColor}20, transparent)`,
            zIndex: 3,
          }}
        />
      </div>

      {/* Reflection */}
      {reflection && (
        <div
          style={{
            width,
            height: height * 0.15,
            transform: `perspective(${perspective}px) rotateY(${enterRotateY}deg) rotateX(${-rotateX}deg) scaleY(-1) scale(${enterScale})`,
            opacity: enterOpacity * 0.12,
            overflow: "hidden",
            maskImage: "linear-gradient(to bottom, rgba(0,0,0,0.3), transparent)",
            WebkitMaskImage: "linear-gradient(to bottom, rgba(0,0,0,0.3), transparent)",
            marginTop: 4,
          }}
        >
          <div
            style={{
              width: "100%",
              height: height,
              overflow: "hidden",
              backgroundColor: "#1a1a1a",
            }}
          >
            {children}
          </div>
        </div>
      )}
    </div>
  );
};
