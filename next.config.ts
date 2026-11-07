import type { NextConfig } from "next";
import os from "os";

// This machine's LAN addresses, so the dev server can be opened from other
// devices (see scripts/lan-proxy.mjs). Next.js blocks cross-origin dev requests
// (HMR, dev assets) from hosts that aren't listed here.
const lanAddresses = Object.values(os.networkInterfaces())
  .flat()
  .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === "IPv4" && !a.internal)
  .map((a) => a.address);

const nextConfig: NextConfig = {
  allowedDevOrigins: lanAddresses,
};

export default nextConfig;
