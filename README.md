# discord-forum-image-tagger
A Docker-based Discord bot that watches specified forum channels, describes attached images with an Ollama vision model, and reduces those descriptions to comma-separated tags with an Ollama text model.

Environment variables:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CHANNEL_IDS`
- `DISCORD_SERVER_ID`
- `OLLAMA_BASE_URL` (default: `http://localhost:11434`)
- `OLLAMA_TEXT_MODEL` (default: `qwen2.5:3b`)
- `OLLAMA_TEXT_PROMPT` (default: `Take this image description and reduce it to a list of tag words separated by commas.`)
- `OLLAMA_TEXT_RETRIES` (default: `3`)
- `OLLAMA_IMAGE_MODEL` (default: `qwen3-vl:2b`)
- `OLLAMA_IMAGE_PROMPT` (default: `Describe this image with as much detail as possible. Leave nothing out.`)
- `OLLAMA_IMAGE_RETRIES` (default: `3`)
