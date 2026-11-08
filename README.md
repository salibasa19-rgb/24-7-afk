# Enderlørd AFK Bot

24/7 AFK Minecraft bot (Aternos-friendly) by **Enderlørd**.

- Discord: https://discord.gg/kkfg4MM8
- YouTube: Enderlørd Minecraft — Subscribe now!

## Setup
1. Edit `settings.json` → set `server.ip`, `server.port`, `server.version`.
2. `npm install`
3. `npm start`
4. Open `http://localhost:5000` for the dashboard (logs, start/stop, console).

On Aternos: use Paper, turn on Cracked mode, add ViaVersion / ViaBackwards / ViaRewind.

## NØVA AI (Gemini)
Say **NØVA** in chat and the bot answers with Gemini AI.
- Put your key in `.env`:  `GEMINI_API_KEY=your_key`  (see `.env.example`). `.env` is git-ignored — never upload it.
- On Replit/Render add `GEMINI_API_KEY` as a Secret / Environment Variable instead.
- Personality, model and cooldown: `settings.json` → `ai`.

## Real-player mode (no owner needed)
NØVA plays survival on its own, forever (`settings.json` -> `player`):
1. Chops trees, crafts planks / crafting table / wooden tools
2. Builds a 5x5 house with roof and a door
3. Mines stone, crafts stone tools
4. Then loops: chops, mines, hunts food, explores, chills at home
5. Fights hostile mobs, eats when hungry, goes home (and sleeps if it has a bed) at night
Progress is saved in `progress.json`, so it continues after reconnects/restarts.
