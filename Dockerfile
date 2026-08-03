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
ENV OLLAMA_TEXT_MODEL=qwen2.5:3b
ENV OLLAMA_TEXT_PROMPT="Take this image description and reduce it to a list of tag words separated by commas."
ENV OLLAMA_TEXT_RETRIES=3
ENV OLLAMA_IMAGE_MODEL=qwen3-vl:2b
ENV OLLAMA_IMAGE_PROMPT="Describe this image with as much detail as possible. Leave nothing out."
ENV OLLAMA_IMAGE_RETRIES=3
ENV DISCORD_BOT_TOKEN=""
ENV DISCORD_SERVER_ID=""
ENV DISCORD_CHANNEL_IDS=""

# Run the app
CMD [ "npm", "start" ]
