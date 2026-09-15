**[SDCodex](https://github.com/LainStable/SDCodex)** is a modular web application built with Flask for exploring, organizing, and managing Stable Diffusion and Generative AI models. It provides a clean, fast interface to browse Civitai models, organize your local library, and dynamically extend functionality through a **Plugin System**.

---

## 🏛️ Core Features

- **Model Explorer & Civitai Browser:** Browse AI models by type (Checkpoint, LoRA, VAE, etc.), base model (SD 1.5, SDXL, Flux, Pony, Wan Video, etc.), and tags.
- **Library Management:** Organize downloaded models and scan local directories to auto-populate metadata and preview images.
- **Creator Profiles:** Explore creators and see all models associated with them.
- **Download Queue:** Integrated background download manager for model weights and previews.
- **Plugin System:** Install, update, and manage official and community plugins directly from GitHub repositories.

---
## 🧩 Plugin System

SDCodex features an extensible plugin architecture. The core application provides Home, Models, and Library. All additional features are modular plugins that can be installed from within the app:

### Official Plugins

1. **[SDCodex-ComfyCaption](https://github.com/LainStable/SDCodex-ComfyCaption)**
   - Auto-captioning with vision LLMs and JoyCaption.
   - Custom ComfyUI nodes (`comfyui-sdcodex`) to browse and load SDCodex galleries in workflows.

2. **[SDCodex-GalleryDL](https://github.com/LainStable/SDCodex-GalleryDL)**
   - Automated batch image download tasks using `gallery-dl` and `yt-dlp`.
   - Single-URL quick download with real-time log streaming.
   - Slideshow kiosks and OAuth credential management for Reddit, DeviantArt, Tumblr, Flickr, and more.

3. **[SDCodex-RemBG](https://github.com/LainStable/SDCodex-RemBG)**
   - High-accuracy background removal and replacement powered by BiRefNet.
   - Quick BG Remove, BG Replace (custom colors/images), and Background Batch Processing.

4. **[SDCodex-Gallery](https://github.com/LainStable/SDCodex-Gallery)**
   - a disk-backed media gallery that scans folders directly from disk
   - reads image captions, SD prompts and ComfyUI workflows from the images' own metadata and lets you download  
     any ComfyUI workflow as JSON

## 🔐 Users & SSO (local auth + OpenID Connect)

   * **Enable authentication** (a toggle). Until at least one user exists the app
  will prompts for you to create a user that will have administrator rights ("bootstrap mode") so you can't lock yourself out.
   * **Local users** — create username/password accounts. Passwords are hashed with
  scrypt (constant-time). Logging in issues an httpOnly session cookie
  (`sameSite=lax`, `Secure` only behind an HTTPS reverse proxy); the Civitai API
  key becomes a per-user setting rather than the login credential.
   * **Single sign-on via OIDC** — add one or more OpenID Connect providers
   (Keycloak, Authelia, Authentik, Azure AD, Google…):

   
## 🛠️ Plugin Development

Any GitHub repository can be added as a plugin by including a `plugin.json` manifest at its root:

```json
{
  "id": "my-plugin",
  "name": "My Custom Plugin",
  "version": "1.0.0",
  "description": "Custom feature description",
  "author": "YourName",
  "repository": "https://github.com/username/my-plugin",
  "entrypoint": "plugin:init_plugin",
  "nav_items": [
    {
      "label": "My Feature",
      "url": "/my-feature",
    }
  ],
  "volumes": [
    {
      "env_var": "MY_DATA",
      "host_path": "./my_data",
      "container_path": "/data/my_data",
      "description": "Host storage directory for plugin data"
    }
  ]
} 

## 🛠️ **[Plugin Update Repository](https://github.com/LainStable/SDCodex-Updater)**

Example json

  ```json
  {
  "name": "SDCodex Plugin Updates",
  "description": "Official Index of SDCodex community plugins. Adding a plugin here makes it installable through SDCodex Settings -> Plugins.",
  "version": "0.0.0",
  "plugins": [
    {
      "id": "comfy-caption",
      "name": "ComfyUI Captioning",
      "description": "Auto-captioning with LLMs/JoyCaption and ComfyUI custom workflow nodes. Captioning GGUF models can be downloaded from HuggingFace via the Caption Models settings page.",
      "repository": "https://github.com/LainStable/SDCodex-ComfyCaption",
      "version": "0.0.0"
    },
    {
      "id": "gallery",
      "name": "SDCodex Gallery",
      "description": "Disk-backed media gallery built into the SD Codex header. Scans folders directly, reads captions/.txt sidecars, SD prompts and ComfyUI workflows from image metadata, and downloads workflows as JSON.",
      "repository": "https://github.com/LainStable/SDCodex-Gallery",
      "version": "0.0.0"
    },
    {
      "id": "gallery-dl",
      "name": "GalleryDL & Tools",
      "description": "Background gallery-dl and yt-dlp task management, quick downloads, kiosks, OAuth configuration, and a persistent activity log.",
      "repository": "https://github.com/LainStable/SDCodex-GalleryDL",
      "version": "0.0.0"
    },
    {
      "id": "rembg",
      "name": "RemBG Background Tools",
      "description": "High-precision background removal, replacement, and batch processing powered by BiRefNet.",
      "repository": "https://github.com/LainStable/SDCodex-RemBG",
      "version": "0.0.0"
    }
  ]
}
 
  ```
 
---

## 📜 License
MIT License