# TPI Submit Bot - Production Deployment Guide

## Overview
This guide covers deploying the TPI Submit Bot to production environments like Coolify, Docker, or any container orchestration platform.

## Prerequisites
- Docker installed on your system
- Environment variables configured
- Valid TPI Suitcase credentials

## Quick Start

### 1. Environment Configuration
Copy the example environment file and configure it:
```bash
cp .env.example .env
```

Edit `.env` with your actual credentials:
```bash
USERNAME=your_tpi_username
PASSWORD=your_tpi_password
```

### 2. Local Development
```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Test the API
curl -X POST -H "Content-Type: application/json" -d @sample.json http://localhost:3000/trigger-bot
```

### 3. Docker Deployment

#### Build and Run with Docker
```bash
# Build the Docker image
npm run docker:build

# Run with Docker
npm run docker:run
```

#### Using Docker Compose
```bash
# Build and run with docker-compose
npm run docker:compose
```

### 4. Production Deployment

#### For Coolify or similar platforms:
1. Push your code to a Git repository
2. Create a new service in Coolify
3. Set the following environment variables:
   - `USERNAME`: Your TPI Suitcase username
   - `PASSWORD`: Your TPI Suitcase password
   - `NODE_ENV`: production
4. Deploy using the Dockerfile

#### Manual Docker Deployment:
```bash
# Build production image
docker build -t tpi-submit-bot .

# Run with environment variables
docker run -d \
  --name tpi-submit-bot \
  -p 3000:3000 \
  -e USERNAME=your_username \
  -e PASSWORD=your_password \
  -e NODE_ENV=production \
  --restart unless-stopped \
  tpi-submit-bot
```

## API Endpoints

### Health Check
```
GET /health
```
Returns server health status, uptime, and memory usage.

### Root Endpoint
```
GET /
```
Returns API information and available endpoints.

### Trigger Bot
```
POST /trigger-bot
```
Processes TPI form submissions. Expects JSON array of booking data.

## Configuration

### Environment Variables
- `USERNAME`: TPI Suitcase username (required)
- `PASSWORD`: TPI Suitcase password (required)
- `PORT`: Server port (default: 3000)
- `NODE_ENV`: Environment (production/development)

### Resource Requirements
- **Memory**: 512MB minimum, 2GB recommended
- **CPU**: 0.5 cores minimum, 1 core recommended
- **Storage**: 1GB minimum

## Security Features
- Runs as non-root user
- Security-hardened browser configuration
- Resource limits to prevent memory leaks
- Health checks for monitoring

## Monitoring
- Health endpoint: `/health`
- Docker health checks configured
- Structured logging with rotation

## Troubleshooting

### Common Issues
1. **Browser launch fails**: Ensure proper Playwright dependencies
2. **Memory issues**: Increase container memory limits
3. **Timeout errors**: Check network connectivity to TPI Suitcase

### Logs
```bash
# View container logs
docker logs tpi-submit-bot

# Follow logs in real-time
docker logs -f tpi-submit-bot
```

## Performance Optimization
- Browser runs in headless mode for better performance
- Single-process mode to reduce memory usage
- Automatic resource cleanup after each request
- Connection pooling for better efficiency

## Scaling
For high-volume usage, consider:
- Horizontal scaling with multiple container instances
- Load balancing between instances
- Queue-based processing for better reliability
- Monitoring and alerting setup