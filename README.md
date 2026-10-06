# pi-effort-slider

Amp-style reasoning effort slider for [Pi](https://pi.dev). A bottom-right popup with a dotted track that sweeps left to right. It spans every thinking level the current model supports.

## Install

```bash
pi install git:github.com/VinhLe1410/pi-effort-slider
```

Run `/reload` after installing.

## Use

`Shift+Tab` opens the slider. Press it again inside to cycle effort forward.

The extension consumes that key before the built-in thinking cycler sees it, so the default Shift+Tab cycle is shadowed while installed. Left and right in the slider replace it. To keep both, rebind `app.thinking.cycle` to another key in `<agent-dir>/keybindings.json`.

## Controls

| Key | Action |
| --- | --- |
| shift+tab | Open the slider, inside it cycles effort forward |
| left/right or h/l | Change effort, applied live |
| tab or ctrl+p | Cycle model, scoped models first |
| typing | Dismisses the slider, text lands in the editor |
| enter | Confirm and close |
| esc | Close, keeps last applied level |

`/effort` opens the slider. `/effort high` sets a level directly. `Ctrl+Shift+E` opens the slider as a fallback.

## Config

Optional `~/.pi/agent/effort-slider.json`:

```json
{
  "levels": ["low", "medium", "high"],
  "descriptions": {
    "medium": "Default for most tasks, balancing quality, speed, and cost."
  }
}
```

Configured levels are intersected with what the current model supports. Without config the slider spans every level the model supports.

## Known gaps

- The extension API `setThinkingLevel` has no persist flag, so saving a default still needs `/thinking` plus `Ctrl+S`.
- Tab cycling follows scoped models, not the exact `Ctrl+P` order.
