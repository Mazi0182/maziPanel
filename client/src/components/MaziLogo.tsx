import React from 'react';

interface MaziLogoProps {
  className?: string;
  size?: number;
}

export const MaziLogo: React.FC<MaziLogoProps> = ({ className = '', size = 38 }) => {
  return (
    <div 
      id="mazipanel_logo_monochrome"
      className={`relative flex items-center justify-center rounded-2xl overflow-hidden bg-zinc-900 border border-white/20 shadow-2xl group select-none ${className}`}
      style={{ width: size, height: size }}
      aria-label="maziPanel Logosu"
    >
      {/* Background Subtle Gradient Glow */}
      <div className="absolute inset-0 bg-gradient-to-br from-white/20 via-white/5 to-zinc-950" />

      {/* SVG Geometric Monogram 'M' in Rounded Oval/Squircle Container */}
      <svg
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-4/5 h-4/5 relative z-10"
      >
        <defs>
          {/* Metallic Silver Gradient */}
          <linearGradient id="silverGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="50%" stopColor="#d4d4d8" />
            <stop offset="100%" stopColor="#71717a" />
          </linearGradient>

          {/* Dark Chrome Inner Shadow */}
          <linearGradient id="chromeGrad" x1="100%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#e4e4e7" />
            <stop offset="100%" stopColor="#27272a" />
          </linearGradient>

          {/* Specular White Highlight */}
          <linearGradient id="highlightGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Outer Oval/Squircle Rounded Shield */}
        <rect
          x="5"
          y="5"
          width="54"
          height="54"
          rx="18"
          stroke="url(#silverGrad)"
          strokeWidth="2.5"
          fill="#111216"
        />

        {/* Inner Subtle Ring */}
        <rect
          x="9"
          y="9"
          width="46"
          height="46"
          rx="14"
          stroke="rgba(255,255,255,0.12)"
          strokeWidth="1"
          fill="none"
        />

        {/* Monogram 'M' Geometric Polygons */}
        {/* Left Leg */}
        <path
          d="M17 46V21L26 34V46H17Z"
          fill="url(#silverGrad)"
        />

        {/* Right Leg */}
        <path
          d="M47 46V21L38 34V46H47Z"
          fill="url(#chromeGrad)"
        />

        {/* Center Apex Diamond */}
        <polygon
          points="32,23 38,32 32,41 26,32"
          fill="#ffffff"
        />

        {/* Glass Sheen Top Reflection */}
        <path
          d="M9 22C16 12 48 12 55 22C41 24 23 24 9 22Z"
          fill="url(#highlightGrad)"
        />
      </svg>

      {/* Outer Glow on Hover */}
      <div className="absolute inset-0 rounded-2xl border border-white/20 transition-opacity duration-300 opacity-0 group-hover:opacity-100 shadow-[0_0_15px_rgba(255,255,255,0.25)] pointer-events-none" />
    </div>
  );
};
