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
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3-vl:2b';
const OLLAMA_PROMPT = process.env.OLLAMA_PROMPT || "What's in this image?";

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

// In-Memory Queue for Ollama requests (sequential to avoid concurrent GPU thrashing)
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

// Helper: split long messages into chunks under maxLength characters
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

// Helper: extract the first uninterrupted numeric ID (4+ digits) from an image filename.
// Handles filenames like "12345.png", "12345-67890.png", "prefix_12345.jpg", etc.
function extractImageId(filename) {
  const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
  const match = nameWithoutExt.match(/(\d{4,})/);
  return match ? match[1] : null;
}

// Read image dimensions from common image formats without decoding the full image.
function getImageDimensions(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (buffer.length >= 10 && (buffer.subarray(0, 6).toString() === 'GIF87a' || buffer.subarray(0, 6).toString() === 'GIF89a')) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  if (buffer.length >= 30 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') {
    const type = buffer.subarray(12, 16).toString();
    if (type === 'VP8X' && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
  }

  if (buffer.length >= 2 && buffer.readUInt16BE(0) === 0xffd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + segmentLength;
    }
  }

  return null;
}

// Helper: fetch the starter message for a thread, retrying up to 5 times
async function fetchStarterMessageWithRetry(thread) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const msg = await thread.fetchStarterMessage();
      if (msg) return msg;
    } catch (err) {
      console.log(`[Attempt ${attempt}/5] Failed to fetch starter message for "${thread.name}": ${err.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return null;
}

// Rename a thread using the detected ID and dimensions from its image attachments.
async function renameThreadWithId(thread, imageAttachments) {
  let detectedId = null;
  for (const [_, attachment] of imageAttachments) {
    detectedId = extractImageId(attachment.name);
    if (detectedId) break;
  }

  if (!detectedId) return;

  const dimensions = [];
  for (const [_, attachment] of imageAttachments) {
    try {
      const response = await fetch(attachment.url);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const imageBuffer = Buffer.from(await response.arrayBuffer());
      const size = getImageDimensions(imageBuffer);
      if (size) {
        dimensions.push(size);
        console.log(`Image ${attachment.name}: ${size.width}x${size.height} (${size.width * size.height} pixels)`);
      } else {
        console.warn(`Could not determine dimensions for image ${attachment.name}.`);
      }
    } catch (err) {
      console.warn(`Failed to inspect image ${attachment.name}: ${err.message}`);
    }
  }

  const originalTitle = thread.name;
  const firstImage = dimensions[0];
  const mapSize = firstImage && firstImage.width % 128 === 0 && firstImage.height % 128 === 0
    ? `${firstImage.width / 128}x${firstImage.height / 128}`
    : null;
  const newTitle = mapSize
    ? `${detectedId} | ${mapSize} | ${originalTitle}`
    : `${detectedId} | ${originalTitle}`;
  console.log(`Renaming thread to: "${newTitle}"`);
  try {
    await thread.setName(newTitle);
  } catch (err) {
    console.warn(`Could not rename thread "${thread.name}": ${err.message}`);
  }
}

// Run Ollama image description and post results to the thread
async function describeAndReply(thread, imageAttachments) {
  let typingInterval = null;
  try {
    // Start typing indicator and keep it alive during the Ollama request
    await thread.sendTyping().catch(err => console.warn(`Failed to send typing indicator: ${err.message}`));
    typingInterval = setInterval(() => {
      thread.sendTyping().catch(err => console.warn(`Failed to send typing indicator: ${err.message}`));
    }, 5000);

    // Convert images to base64
    const base64Images = [];
    for (const [_, attachment] of imageAttachments) {
      try {
        const res = await fetch(attachment.url);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const buffer = await res.arrayBuffer();
        base64Images.push(Buffer.from(buffer).toString('base64'));
      } catch (err) {
        console.error(`Failed to download image ${attachment.name}:`, err.message);
      }
    }

    if (base64Images.length === 0) {
      console.error(`Failed to download any images for thread "${thread.name}". Skipping Ollama.`);
      return;
    }

    // Query Ollama with up to 3 attempts
    const MAX_OLLAMA_ATTEMPTS = 3;
    let description = null;
    for (let attempt = 1; attempt <= MAX_OLLAMA_ATTEMPTS; attempt++) {
      console.log(`Sending ${base64Images.length} image(s) to Ollama (${OLLAMA_MODEL})... [attempt ${attempt}/${MAX_OLLAMA_ATTEMPTS}]`);
      try {
        const ollamaResponse = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: OLLAMA_PROMPT,
            images: base64Images,
            stream: false,
            keep_alive: 0,
          }),
        });

        if (!ollamaResponse.ok) {
          throw new Error(`Ollama API returned HTTP ${ollamaResponse.status}`);
        }

        const responseData = await ollamaResponse.json();
        if (!responseData.response) {
          throw new Error("Empty description returned from Ollama API");
        }

        description = responseData.response;
        break; // success — exit retry loop
      } catch (err) {
        console.warn(`Ollama attempt ${attempt}/${MAX_OLLAMA_ATTEMPTS} failed for thread "${thread.name}": ${err.message}`);
        if (attempt < MAX_OLLAMA_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
    }

    if (!description) {
      throw new Error(`Ollama failed to return a description after ${MAX_OLLAMA_ATTEMPTS} attempts.`);
    }

    // Post description back to the forum thread, split into ≤1800-char chunks
    const messageChunks = splitMessage(description, 1800);
    for (const chunk of messageChunks) {
      await thread.send(chunk);
    }
    console.log(`Replied to "${thread.name}" with ${messageChunks.length} message(s).`);
  } catch (error) {
    console.error(`Error describing images in thread "${thread.name}":`, error);
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }
}

// Initialize Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageTyping,
  ],
});

client.once(Events.ClientReady, () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

// Watch for new threads (forum posts are threads)
client.on('threadCreate', async (thread) => {
  // Filter by server
  if (DISCORD_SERVER_ID && thread.guildId !== DISCORD_SERVER_ID) return;

  // Filter by channel
  if (!DISCORD_CHANNEL_IDS.includes(thread.parentId)) return;

  console.log(`New forum post detected: "${thread.name}" (ID: ${thread.id})`);

  // Fetch the starter message immediately (with retries)
  const starterMessage = await fetchStarterMessageWithRetry(thread);
  if (!starterMessage) {
    console.error(`Could not fetch starter message for thread "${thread.name}". Skipping.`);
    return;
  }

  // Collect image attachments
  const imageAttachments = starterMessage.attachments.filter(a => (a.contentType || '').startsWith('image/'));

  if (imageAttachments.size === 0) {
    console.log(`No images in thread "${thread.name}". Skipping.`);
    return;
  }

  console.log(`Found ${imageAttachments.size} image(s) in thread "${thread.name}".`);

  // Rename after inspecting image dimensions, then queue Ollama processing.
  await renameThreadWithId(thread, imageAttachments);

  // Queue Ollama processing — starts right away if nothing else is in queue
  taggerQueue.enqueue(() => describeAndReply(thread, imageAttachments));
});

client.login(DISCORD_BOT_TOKEN);
