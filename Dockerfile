# Use the latest official Playwright Node.js image for browser automation
FROM mcr.microsoft.com/playwright:v1.45.1-jammy

# Create and change to the app directory
WORKDIR /usr/src/app

# Copy application dependency manifests to the container image
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# Copying this first prevents re-running npm install on every code change
COPY package*.json ./

# Install production dependencies including axios for webhook functionality
RUN npm ci --only=production

# Install Playwright browsers with dependencies for headless operation
RUN npx playwright install --with-deps chromium

# Copy local code to the container image
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Set environment for production
ENV NODE_ENV=production

# Run the web service on container startup
CMD ["npm", "start"]
