# Lightweight Node.js LTS production image
FROM node:20-alpine

# Set environment
ENV NODE_ENV=production
WORKDIR /app

# Copy dependency definitions and install production packages
COPY package.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Expose server port (default 3000)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

# Start server
CMD ["node", "server.js"]
