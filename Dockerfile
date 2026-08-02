FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Bundle app source
COPY src/ ./src/

# Define default environment variables
ENV OLLAMA_BASE_URL=http://localhost:11434
ENV OLLAMA_MODEL=qwen3-vl:2b
ENV OLLAMA_PROMPT="What's in this image?"
ENV DISCORD_BOT_TOKEN=""
ENV DISCORD_SERVER_ID=""
ENV DISCORD_CHANNEL_IDS=""

# Run the app
CMD [ "npm", "start" ]
