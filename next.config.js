/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3000/api/:path*',
      },
      {
        source: '/audit-log',
        destination: 'http://localhost:3000/audit-log',
      },
    ];
  },
};

module.exports = nextConfig;
