import { Client, GatewayIntentBits, Events } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

// Validate Environment Variables
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_SERVER_ID = process.env.DISCORD_SERVER_ID;
const DISCORD_CHANNEL_IDS = process.env.DISCORD_CHANNEL_IDS 
  ? process.env.DISCORD_CHANNEL_IDS.split(',').map(id => id.trim()) 
  : [];
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llava';
const OLLAMA_PROMPT = process.env.OLLAMA_PROMPT || 'Describe this image in bullet points.';

if (!DISCORD_BOT_TOKEN) {
  console.error("ERROR: DISCORD_BOT_TOKEN is required.");
  process.exit(1);
}

if (DISCORD_CHANNEL_IDS.length === 0) {
  console.warn("WARNING: DISCORD_CHANNEL_IDS is empty. The bot will not watch any channels.");
}

console.log("Starting Discord Forum Image Tagger Bot...");
if (DISCORD_SERVER_ID) {
  console.log(`Watching Server (Guild) ID: ${DISCORD_SERVER_ID}`);
}
console.log(`Watching Channel IDs: ${DISCORD_CHANNEL_IDS.join(', ')}`);
console.log(`Ollama Base URL: ${OLLAMA_BASE_URL}`);
console.log(`Ollama Model: ${OLLAMA_MODEL}`);
console.log(`Ollama Prompt: ${OLLAMA_PROMPT}`);

// In-Memory Queue implementation
class TaskQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
  }

  enqueue(task) {
    this.queue.push(task);
    this.processNext();
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const task = this.queue.shift();

    try {
      await task();
    } catch (error) {
      console.error("Error executing queued task:", error);
    } finally {
      this.isProcessing = false;
      this.processNext();
    }
  }
}

const taggerQueue = new TaskQueue();

// Helper function to split long messages into chunks under 1800 characters
function splitMessage(text, maxLength = 1800) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let currentChunk = '';
  const lines = text.split('\n');
  
  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
      if (line.length > maxLength) {
        let remaining = line;
        while (remaining.length > maxLength) {
          chunks.push(remaining.substring(0, maxLength));
          remaining = remaining.substring(maxLength);
        }
        currentChunk = remaining;
      } else {
        currentChunk = line;
      }
    } else {
      currentChunk = currentChunk ? currentChunk + '\n' + line : line;
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  return chunks;
}


// Initialize Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

// Watch for new threads (forum posts are threads)
client.on('threadCreate', async (thread) => {
  // Check if thread belongs to the configured server (guild)
  if (DISCORD_SERVER_ID && thread.guildId !== DISCORD_SERVER_ID) {
    return;
  }

  // Check if the thread is created in one of the watched forum channels
  if (!DISCORD_CHANNEL_IDS.includes(thread.parentId)) {
    return;
  }

  console.log(`New forum post detected: "${thread.name}" (ID: ${thread.id}) in parent channel ${thread.parentId}`);

  // Enqueue the processing of the thread
  taggerQueue.enqueue(async () => {
    let typingInterval = null;
    try {
      console.log(`Processing thread "${thread.name}"...`);

      // Start typing indicator and refresh it every 5 seconds
      await thread.sendTyping().catch(err => console.warn(`Failed to send initial typing indicator: ${err.message}`));
      typingInterval = setInterval(() => {
        thread.sendTyping().catch(err => console.warn(`Failed to send typing indicator: ${err.message}`));
      }, 5000);

      // Discord forum threads might not have the starter message populated instantly.
      // We will attempt to fetch it with retries.
      let starterMessage = null;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          starterMessage = await thread.fetchStarterMessage();
          if (starterMessage) break;
        } catch (err) {
          console.log(`[Attempt ${attempt}/5] Failed to fetch starter message: ${err.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      if (!starterMessage) {
        console.error(`Could not fetch starter message for thread "${thread.name}". Skipping.`);
        return;
      }

      // Find image attachments
      const imageAttachments = starterMessage.attachments.filter(attachment => {
        const contentType = attachment.contentType || '';
        return contentType.startsWith('image/');
      });

      if (imageAttachments.size === 0) {
        console.log(`No images found in starter message for thread "${thread.name}". Skipping.`);
        return;
      }

      console.log(`Found ${imageAttachments.size} image(s) in thread "${thread.name}". Describing...`);

      // Convert images to base64 strings
      const base64Images = [];
      for (const [_, attachment] of imageAttachments) {
        try {
          const res = await fetch(attachment.url);
          if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
          const buffer = await res.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          base64Images.push(base64);
        } catch (err) {
          console.error(`Failed to download image ${attachment.name}:`, err.message);
        }
      }

      if (base64Images.length === 0) {
        console.error(`Failed to download any images for thread "${thread.name}". Skipping.`);
        return;
      }

      // Query Ollama
      console.log(`Sending image(s) to Ollama API at ${OLLAMA_BASE_URL} (Model: ${OLLAMA_MODEL})...`);
      const ollamaResponse = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          prompt: OLLAMA_PROMPT,
          images: base64Images,
          stream: false,
        }),
      });

      if (!ollamaResponse.ok) {
        throw new Error(`Ollama API returned HTTP ${ollamaResponse.status}`);
      }

      const responseData = await ollamaResponse.json();
      const description = responseData.response;

      if (!description) {
        throw new Error("Empty description returned from Ollama API");
      }

      // Post the response back to the forum thread, split into chunks of max 1800 chars
      const messageChunks = splitMessage(description, 1800);
      for (const chunk of messageChunks) {
        await thread.send(chunk);
      }
      console.log(`Successfully replied to thread "${thread.name}" with Ollama description (${messageChunks.length} message(s)).`);
    } catch (error) {
      console.error(`Error processing thread "${thread.name}":`, error);
    } finally {
      if (typingInterval) {
        clearInterval(typingInterval);
      }
    }
  });
});

client.login(DISCORD_BOT_TOKEN);
