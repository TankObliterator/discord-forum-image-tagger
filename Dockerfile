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
ENV OLLAMA_MODEL=llava
ENV OLLAMA_PROMPT="Describe this image in bullet points."
ENV DISCORD_BOT_TOKEN=""
ENV DISCORD_CHANNEL_IDS=""

# Run the app
CMD [ "npm", "start" ]
