import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config) => {
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ["**/apps/**", "**/node_modules/**"],
    };
    return config;
  },
};

export default nextConfig;
