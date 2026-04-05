import React from "react";
import { spring, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

interface TextRevealProps {
  text: string;
  delay?: number;
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  style?: React.CSSProperties;
}

export const TextReveal: React.FC<TextRevealProps> = ({
  text,
  delay = 0,
  fontSize = 72,
  color = "#f8fafc",
  fontFamily = "Inter, sans-serif",
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const springValue = spring({
    frame: frame - delay,
    fps,
    config: { damping: 20, stiffness: 80, mass: 1.2 },
    durationRestThreshold: 0.001,
  });

  const translateY = interpolate(springValue, [0, 1], [50, 0]);
  const opacity = interpolate(springValue, [0, 1], [0, 1]);

  return (
    <div
      style={{
        fontSize,
        fontFamily,
        fontWeight: 700,
        color,
        transform: `translateY(${translateY}px)`,
        opacity,
        textAlign: "center",
        lineHeight: 1.2,
        ...style,
      }}
    >
      {text}
    </div>
  );
};
