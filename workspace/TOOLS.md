# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

## Trading (OpenClaw + daemon)

- **Policy & pause:** `trading/policy.json`, `trading/PAUSE` — OpenClaw may update thresholds or pause when asked; never store keys here.
- **Runtime truth:** `trading/state.json`, `trading/signals.jsonl` — written by the pump.fun daemon, not by hand when the bot runs.

Add whatever helps you do your job. This is your cheat sheet.
