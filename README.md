# Banter Colour Drop Game

This is a Banter SDK-powered Colour Drop game, inspired by classic minigames where players must stand on the correct colored tile to survive. The game features dynamic tile generation, multiplayer synchronization, and a scoreboard.

## How to Play

1.  **Spawn in the Lobby:** You will start in the spectator lobby area.
2.  **Read the Rules:** Check the "HOW TO PLAY" sign in the lobby for a quick overview.
3.  **Join the Game:** Click the **"JOIN GAME"** button to teleport to the arena.
4.  **Watch the Displays:** Look at the large floating displays above the arena. They will show a countdown and the **TARGET COLOR** you need to stand on.
5.  **Find Your Tile:** Quickly move to any tile on the grid that matches the target color.
6.  **Survive the Drop:** When the countdown ends, all tiles that are *not* the target color will disappear, causing anyone on the wrong tile to fall.
7.  **Repeat:** The remaining tiles will reappear, and a new round will begin with a new target color.
8.  **Last Player Standing:** The game continues until only one player remains, or until all players fall.

## Controls & Options (Lobby Buttons)

The lobby area features a control panel with several buttons:

*   **HARD MODE: [ON/OFF]**
    *   Toggles whether the tile colors on the board reshuffle randomly each round.
    *   If **ON**: The board layout changes every round, increasing difficulty.
    *   If **OFF**: The board layout remains static throughout the game.
    *   Also affects how quickly the countdown speeds up per round.
*   **JOIN GAME**
    *   Teleports you from the lobby to the game arena.
    *   Starts tracking your survival time for the current game session.
    *   If the game is in "LOBBY" status, clicking this button (or entering the arena) will initiate the game sequence.
*   **SET: 5S / SET: 10S**
    *   Allows the host to set the initial countdown duration for each round (5 or 10 seconds).
*   **MUTE AUDIO / UNMUTE AUDIO**
    *   A local-only button that toggles the countdown "tick" sound for your client.
*   **RESET GAME**
    *   (Host only) Resets the game state back to "LOBBY" status, clearing the current round and countdown.

## Scoring

A scoreboard is displayed in the lobby, tracking player performance across game sessions:

*   **Falls:** The total number of times a player has fallen from the arena.
*   **Best Normal Survival:** The longest time a player has survived in a single game session while Hard Mode was OFF.
*   **Best Hard Survival:** The longest time a player has survived in a single game session while Hard Mode was ON.

Scores are updated automatically and persist across sessions within the space.

## Technical Details

*   **Banter SDK:** This game is built entirely using the Banter JavaScript SDK, leveraging `GameObject`s, `Component`s (BoxCollider, BanterMaterial, BanterText, BanterAudioSource, etc.), and `spaceState` for multiplayer synchronization.
*   **Multiplayer Sync:** The core game state (current status, round, target color, random seed, timers, hard mode setting) is synchronized across all connected clients using a single `spaceState` property.
*   **Host-Driven Logic:** The client with the lowest User ID (UID) automatically acts as the "host" to drive the game's state transitions, ensuring consistent timing and logic for all players.
*   **Collision-Based Player State:** Player participation (`isLocalInArena`) is managed using trigger colliders rather than `userProps` due to current SDK limitations, ensuring reliable fall detection and score tracking.
*   **Dynamic UI:** Game information (countdown, target color) is displayed on large, multi-directional UI elements above the arena for clear visibility from all angles.
*   **Score Persistence:** Player fall counts and best survival times are stored in `spaceState` as JSON objects per user, allowing scores to persist.
