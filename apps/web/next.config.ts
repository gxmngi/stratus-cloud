import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // สร้าง .next/standalone สำหรับ Docker image ขนาดเล็ก (ดู apps/web/Dockerfile)
  output: "standalone",
};

export default nextConfig;
