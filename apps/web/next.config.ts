import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // สร้าง .next/standalone สำหรับ Docker image ขนาดเล็ก (ดู apps/web/Dockerfile)
  output: "standalone",
};

export default nextConfig;
