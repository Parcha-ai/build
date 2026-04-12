import { memo } from "react";

interface ClaudetteBrandLogoProps {
  size?: "xs" | "small" | "medium" | "large";
  className?: string;
  showIcon?: boolean;
}

const sizeMap = {
  xs: { width: 80, height: 20, fontSize: 14, iconSize: 16 },
  small: { width: 120, height: 28, fontSize: 18, iconSize: 22 },
  medium: { width: 160, height: 36, fontSize: 24, iconSize: 28 },
  large: { width: 220, height: 48, fontSize: 32, iconSize: 38 },
};

// Pixel-art magnifying glass icon - Build logo
const BuildIcon = memo(({ size = 28, className = "" }: { size?: number; className?: string }) => {
  const scale = size / 32; // Base size is 32x32
  const pixelSize = 2 * scale;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Lens circle */}
      <rect x="6" y="8" width="2" height="2" fill="currentColor" />
      <rect x="8" y="6" width="2" height="2" fill="currentColor" />
      <rect x="10" y="6" width="4" height="2" fill="currentColor" />
      <rect x="14" y="6" width="2" height="2" fill="currentColor" />
      <rect x="16" y="8" width="2" height="2" fill="currentColor" />
      <rect x="4" y="10" width="2" height="2" fill="currentColor" />
      <rect x="18" y="10" width="2" height="2" fill="currentColor" />
      <rect x="4" y="12" width="2" height="2" fill="currentColor" />
      <rect x="18" y="12" width="2" height="2" fill="currentColor" />
      <rect x="4" y="14" width="2" height="2" fill="currentColor" />
      <rect x="18" y="14" width="2" height="2" fill="currentColor" />
      <rect x="6" y="16" width="2" height="2" fill="currentColor" />
      <rect x="16" y="16" width="2" height="2" fill="currentColor" />
      <rect x="8" y="18" width="2" height="2" fill="currentColor" />
      <rect x="10" y="18" width="4" height="2" fill="currentColor" />
      <rect x="14" y="18" width="2" height="2" fill="currentColor" />
      {/* Handle - diagonal */}
      <rect x="18" y="18" width="2" height="2" fill="currentColor" />
      <rect x="20" y="20" width="2" height="2" fill="currentColor" />
      <rect x="22" y="22" width="2" height="2" fill="currentColor" />
      <rect x="24" y="24" width="2" height="2" fill="currentColor" />
      <rect x="26" y="26" width="2" height="2" fill="currentColor" />
    </svg>
  );
});

BuildIcon.displayName = "BuildIcon";

export const BuildBrandLogo = memo(({
  size = "medium",
  className = "",
  showIcon = true
}: ClaudetteBrandLogoProps) => {
  const dimensions = sizeMap[size];

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {showIcon && (
        <BuildIcon size={dimensions.iconSize} className="text-claude-accent" />
      )}
      <span
        className="font-mono font-bold tracking-wider text-current"
        style={{
          fontSize: dimensions.fontSize,
          letterSpacing: '0.15em'
        }}
      >
        BUILD
      </span>
    </div>
  );
});

BuildBrandLogo.displayName = "BuildBrandLogo";

// Backward compatibility exports
export const ClaudetteBrandLogo = BuildBrandLogo;
export { BuildIcon as ClaudetteIcon };
export default BuildBrandLogo;
