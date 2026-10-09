# pi-effort-slider

Amp-style reasoning effort slider for [Pi](https://pi.dev). A bottom-right popup with a dotted track that sweeps left to right. It spans every thinking level the current model supports.

https://github.com/user-attachments/assets/94a3e45a-5bae-45a0-a100-d89a254f3330

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
| typing or enter | Dismisses the slider, input flows to the editor |
| esc or ctrl+c | Dismisses the slider, consumed so runs keep going |
| everything else | Passes through, shortcuts keep working |

Only one slider can be open at a time across every open path. Reopens
within a beat of closing are ignored, so key repeats and stacked
triggers cannot pile overlays.

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
