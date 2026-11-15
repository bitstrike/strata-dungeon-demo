[x] when right and left arrow keys are held down, turning should be smooth and continuous while key is held down. Similar to how the front and back keys work
    -> arrows are tracked in `keys` like WASD; `runTurn(dt)` applies `CFG.turnRate` (1.45 rad/s, ~83 deg/s) every frame while held. A lone tap still banks a clamped 20 deg nudge (`turnKick`, spread over 4 frames). Harness: tap -20.0 deg, one second held -103.1 deg, second second -83.1 deg, 0 after release.

[x] The direction of the player indicator on the mini map is reversed when player is facing east and west
    -> `drawMinimap()` rotated by `-state.yaw`; the chart is drawn x-east / y-south and a canvas rotation runs clockwise on screen, so the negation mirrored the chevron left-right. Now `miniCtx.rotate(state.yaw)`. Harness and screenshot confirm N/E/S/W all point the right way.

[x] The game canvas should recapture the mouse pointer when the user clicks it, currently it does not
    -> a `mousedown` listener on the WebGL canvas (bound inside `initGL()`, where the canvas is actually held) calls `requestLock()` on a left click when the run has started, no overlay is open, and the pointer is loose. A "click the view to take back the mouse" hint shows whenever the cursor is free during play, and the OS cursor is hidden while locked. Harness: click recaptures, click over the settings overlay does not.

[x] add tooltips to Torch and Sight setting widgets to explain in simple terms what each setting is for, what it controls and when to adjust it.
    -> every Torch & sight widget (16 sliders + 5 toggles) has an ⓘ button opening a plain-language bubble (`#tipbox`, hover / focus / click, clamped to the viewport) plus a native `title` on the control itself. Harness: 21 of 21 widgets carry a tooltip of 60+ characters.

[x] Add note to main screen about settings page when esc is hit
    -> the relock banner is now two lines: "click the view to take back the mouse" plus "or press Esc again for torch settings" (the first Esc only frees the pointer, the second reaches the keydown handler and opens the card). A clickable `#gear` "⚙ settings" button sits at the right end of the HUD bar and opens the same card. Both are driven by `updateRelockHint()`, so they show only while the run has started, the cursor is loose and no card is open — while locked the OS cursor is hidden, so an on-screen button would be unaimable. `#hud` is `pointer-events:none`, so `#gear` re-enables it (`pointer-events:auto` when `.on`). Harness `pointer` test: hintWhenUnlocked, gearWhenUnlocked, gearClickableWhenUnlocked, gearOpensSettings, gearHiddenWhileLocked, gearInOverlay, hintMentionsEsc.

[ ] Add model for torch