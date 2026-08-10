import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: true,
  // /balance/import reads the committed sheet export at request time. It is not an
  // import Next can trace, so the file has to be named for the serverless bundle
  // to carry it — otherwise the route works locally and 404s the export on Vercel.
  outputFileTracingIncludes: {
    "/balance/import": ["./docs/source/**"],
  },
};

export default nextConfig;
