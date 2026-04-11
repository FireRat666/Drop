(function () {
    let scene;

    // --- Configuration ---
    const STATE_KEY = "drop_game_state";
    const USER_DATA_KEY_PREFIX = "cd_user:";
    const GRID_SIZE = 8;
    const TILE_SIZE = 3;
    const GAME_HEIGHT = 10;
    const LOBBY_POS_RAW = { x: 0, y: 10.1, z: -40 };

    let COLORS = [
        { name: "Red", vec: [1, 0.1, 0.1, 1] },
        { name: "Green", vec: [0.1, 1, 0.1, 1] },
        { name: "Blue", vec: [0.1, 0.1, 1, 1] },
        { name: "Yellow", vec: [1, 1, 0.1, 1] },
        { name: "Magenta", vec: [1, 0.1, 1, 1] },
        { name: "Cyan", vec: [0.1, 1, 1, 1] },
        { name: "Orange", vec: [1, 0.5, 0.1, 1] },
        { name: "White", vec: [1, 1, 1, 1] }
    ];

    const TIMINGS = {
        LOBBY: 10,
        SHOWING: 7,
        DROPPED: 2,
        RESETTING: 3,
        HOST_STEAL_DURATION: 30000
    };

    // --- State Variables ---
    let gameState = {
        status: "LOBBY",
        round: 0,
        targetColorIndex: 0,
        seed: 0,
        endTime: 0,
        hardMode: false,
        initialCountdown: 7,
        activePlayers: 0,
        currentHostUid: null,
        hostStealStartTime: 0,
        hostStealRequesterUid: null
    };

    let tiles = [];
    let ui = { root: null, displays: [] };
    let audio = { tick: null };
    let isLocalInArena = false;
    let isMuted = false;
    let scoreboardFalls = null;
    let scoreboardNormal = null;
    let scoreboardHard = null;
    let hostDisplay = null;
    let lastFallTime = 0;
    let hostOnlyButtons = [];
    let isResettingSmoothly = false;

    // Local player game session tracking
    let gameStartTime = 0;
    let gameModeAtStart = false;

    // --- Utils ---
    const seededRandom = (seed) => {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    };

    const isHost = () => {
        if (!scene || !scene.localUser) return false;
        if (!gameState.currentHostUid) {
            const uids = Object.keys(scene.users || {}).sort();
            return uids.length > 0 && uids[0] === scene.localUser.uid;
        }
        return gameState.currentHostUid === scene.localUser.uid;
    };

    // Manual Lerp for Vector3
    const lerpVec3 = (a, b, t) => ({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t
    });

    // Manual Slerp (linear approximation) for Quaternion
    const lerpQuat = (a, b, t) => {
        const res = {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            z: a.z + (b.z - a.z) * t,
            w: a.w + (b.w - a.w) * t
        };
        const len = Math.sqrt(res.x * res.x + res.y * res.y + res.z * res.z + res.w * res.w);
        res.x /= len; res.y /= len; res.z /= len; res.w /= len;
        return res;
    };

    // --- Initialization ---
    async function init() {
        if (scene) return;
        scene = BS.BanterScene.GetInstance();

        console.log("DROP GAME: BS Ready. Building Environment...");

        const settings = new BS.SceneSettings();
        settings.EnableTeleport = false;
        settings.EnableJump = true;
        settings.MaxOccupancy = 30;
        settings.RefreshRate = 72;
        settings.ClippingPlane = new BS.Vector2(0.05, 500);
        settings.SpawnPoint = new BS.Vector4(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z, 0);
        scene.SetSettings(settings);

        COLORS = COLORS.map(c => ({ ...c, vec: new BS.Vector4(c.vec[0], c.vec[1], c.vec[2], c.vec[3]) }));

        await buildEnvironment();
        await buildGrid();
        await setupUI();
        await setupAudio();

        if (!scene.unityLoaded) {
            console.log("DROP GAME: Waiting for Unity...");
            await new Promise(resolve => {
                scene.On("unity-loaded", resolve);
                window.addEventListener("unity-loaded", resolve, { once: true });
            });
        }
        console.log("DROP GAME: Unity Loaded!");

        scene.TeleportTo(new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z), 0, true);
        setupNetworking();
        setInterval(update, 100);
        console.log("DROP GAME: Init Complete");
    }

    async function buildEnvironment() {
        const root = await new BS.GameObject({ name: "Environment" }).Async();

        // Lobby Floor
        const floor = await new BS.GameObject({ name: "SpectatorLobby", parent: root, localPosition: new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y - 0.05, LOBBY_POS_RAW.z) }).Async();
        await floor.AddComponent(new BS.BanterBox({ width: 30, height: 0.5, depth: 30 }));
        await floor.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(30, 0.5, 30) }));
        await floor.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(0.1, 0.1, 0.1, 1) }));

        // Rules Text
        const rulesObj = await new BS.GameObject({ name: "RulesText", parent: floor, localPosition: new BS.Vector3(-12, 2, 0), localEulerAngles: new BS.Vector3(0, -90, 0) }).Async();
        await rulesObj.AddComponent(new BS.BanterText({
            text: "<size=1.5><b>HOW TO PLAY</b></size>\n\n1. Click <b>JOIN GAME</b> to teleport.\n2. Look at the displays for the <b>TARGET COLOR</b>.\n3. Stand on a matching tile before time runs out.\n4. All other tiles will drop!\n5. Survive as long as you can.\n\n<color=#ffcc00>Hard Mode: Randomizes board every round!</color>",
            fontSize: 1,
            color: new BS.Vector4(1, 1, 1, 1),
            horizontalAlignment: BS.HorizontalAlignment.Left
        }));

        // Host Display
        const hostObj = await new BS.GameObject({ name: "HostDisplay", parent: floor, localPosition: new BS.Vector3(0, 3.5, 12), localEulerAngles: new BS.Vector3(0, 0, 0) }).Async();
        hostDisplay = await hostObj.AddComponent(new BS.BanterText({
            text: "Waiting for Unity...",
            fontSize: 5,
            color: new BS.Vector4(1, 1, 0, 1),
            horizontalAlignment: BS.HorizontalAlignment.Center
        }));

        // Scoreboard
        const boardRoot = await new BS.GameObject({ name: "Scoreboards", parent: floor, localPosition: new BS.Vector3(12, 3, 0), localEulerAngles: new BS.Vector3(0, 90, 0) }).Async();
        const createBoard = async (name, x, label) => {
            const obj = await new BS.GameObject({ name: name, parent: boardRoot, localPosition: new BS.Vector3(x, 0, 0) }).Async();
            return await obj.AddComponent(new BS.BanterText({
                text: `<b>${label}</b>\n\nWaiting...`,
                fontSize: 0.5,
                color: new BS.Vector4(1, 1, 1, 1),
                horizontalAlignment: BS.HorizontalAlignment.Center
            }));
        };
        scoreboardFalls = await createBoard("FallsBoard", -6, "MOST FALLS");
        scoreboardNormal = await createBoard("NormalBoard", 0, "NORMAL SURVIVAL");
        scoreboardHard = await createBoard("HardBoard", 6, "HARD SURVIVAL");

        // Controls
        const buttonGroup = await new BS.GameObject({ name: "Controls", parent: floor, localPosition: new BS.Vector3(0, 1, 3) }).Async();
        const createBtn = async (name, xPos, color, text, hostOnly, handler) => {
            const btn = await new BS.GameObject({ name: name, parent: buttonGroup, localPosition: new BS.Vector3(xPos, 0, 0) }).Async();
            await btn.AddComponent(new BS.BanterBox({ width: 1, height: 0.4, depth: 0.5 }));
            await btn.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(1, 0.4, 0.5) }));
            const mat = await btn.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: color }));
            btn.SetLayer(5);
            const t = await new BS.GameObject({ name: name + "Text", parent: btn, localPosition: new BS.Vector3(0, 0.4, 0) }).Async();
            await t.AddComponent(new BS.BanterText({ text: text, fontSize: 1.5, color: new BS.Vector4(1, 1, 1, 1), horizontalAlignment: BS.HorizontalAlignment.Center }));

            btn.On("click", async () => {
                // Visual feedback
                const pressedColor = new BS.Vector4(color.x * 0.5, color.y * 0.5, color.z * 0.5, color.w);
                mat.color = pressedColor;
                setTimeout(() => { mat.color = color; }, 200);
                handler();
            });

            if (hostOnly) hostOnlyButtons.push(btn);
            return btn;
        };

        await createBtn("HardModeBtn", -7.5, new BS.Vector4(0.8, 0.1, 0.1, 1), "HARD MODE", true, () => {
            if (!isHost()) return;
            updateState({ hardMode: !gameState.hardMode });
        });

        await createBtn("ClaimHostBtn", -5, new BS.Vector4(1, 0.8, 0, 1), "CLAIM HOST", false, () => {
            const hostPresent = gameState.currentHostUid && scene.users[gameState.currentHostUid];
            if (!hostPresent) {
                updateState({ currentHostUid: scene.localUser.uid, hostStealStartTime: 0, hostStealRequesterUid: null });
            } else if (gameState.currentHostUid === scene.localUser.uid) {
                updateState({ hostStealStartTime: 0, hostStealRequesterUid: null });
            } else {
                updateState({ hostStealStartTime: Date.now(), hostStealRequesterUid: scene.localUser.uid });
            }
        });

        await createBtn("JoinBtn", -2.5, new BS.Vector4(0, 0.5, 1, 1), "JOIN GAME", false, () => {
            scene.TeleportTo(new BS.Vector3(0, GAME_HEIGHT + 2, 0), 0, true);
            if (gameState.status === "LOBBY") {
                updateState({ status: "RESETTING", endTime: Date.now() + 8000 });
            }
        });

        await createBtn("Timer5Btn", 0, new BS.Vector4(0.1, 0.8, 0.1, 1), "5S", true, () => {
            if (!isHost()) return;
            updateState({ initialCountdown: 5 });
        });

        await createBtn("Timer10Btn", 2.5, new BS.Vector4(0.1, 0.7, 0.1, 1), "10S", true, () => {
            if (!isHost()) return;
            updateState({ initialCountdown: 10 });
        });

        await createBtn("MuteBtn", 5, new BS.Vector4(0.5, 0.2, 0.8, 1), "MUTE", false, async (e) => {
            isMuted = !isMuted;
            const txt = await (await scene.Find("MuteBtnText")).GetComponent(BS.CT.BanterText);
            if (txt) txt.text = isMuted ? "UNMUTE" : "MUTE";
        });

        await createBtn("ResetBtn", 7.5, new BS.Vector4(0.5, 0.5, 0.5, 1), "RESET", true, () => {
            if (!isHost()) return;
            updateState({ status: "LOBBY", round: 0 });
        });

        // Arena Tracker
        const arenaTracker = await new BS.GameObject({ name: "ArenaTracker", localPosition: new BS.Vector3(0, GAME_HEIGHT + 2, 0) }).Async();
        await arenaTracker.AddComponent(new BS.BoxCollider({ isTrigger: true, size: new BS.Vector3(GRID_SIZE * TILE_SIZE, 5, GRID_SIZE * TILE_SIZE) }));
        await arenaTracker.AddComponent(new BS.BanterColliderEvents());
        arenaTracker.On("trigger-enter", (e) => {
            if (e.detail.user && e.detail.user.isLocal) {
                isLocalInArena = true;
                if (gameState.status === "LOBBY") updateState({ status: "RESETTING", endTime: Date.now() + 5000 });
            }
        });
        arenaTracker.On("trigger-exit", (e) => {
            if (e.detail.user && e.detail.user.isLocal) isLocalInArena = false;
        });

        // Death Zone
        const deadZone = await new BS.GameObject({ name: "DeadZone", localPosition: new BS.Vector3(0, GAME_HEIGHT - 3, 0) }).Async();
        await deadZone.AddComponent(new BS.BoxCollider({ isTrigger: true, size: new BS.Vector3(100, 2, 100) }));
        await deadZone.AddComponent(new BS.BanterColliderEvents());
        deadZone.On("trigger-enter", (e) => {
            if (e.detail.user && e.detail.user.isLocal) {
                const now = Date.now();
                if (now - lastFallTime > 1000) {
                    lastFallTime = now;
                    updateUserStats(gameStartTime > 0 ? now - gameStartTime : 0, gameModeAtStart);
                    gameStartTime = 0;
                    scene.TeleportTo(new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z), 0, true);
                }
            }
        });
    }

    async function buildGrid() {
        const gridRoot = await new BS.GameObject({ name: "GridRoot", localPosition: new BS.Vector3(0, GAME_HEIGHT, 0) }).Async();
        const offset = (GRID_SIZE * TILE_SIZE) / 2 - (TILE_SIZE / 2);
        const tilePromises = [];

        for (let x = 0; x < GRID_SIZE; x++) {
            for (let z = 0; z < GRID_SIZE; z++) {
                tilePromises.push((async (lx, lz) => {
                    const initialWorldPos = { x: lx * TILE_SIZE - offset, y: GAME_HEIGHT, z: lz * TILE_SIZE - offset };
                    const initialRotation = { x: 0, y: 0, z: 0, w: 1 };
                    const tile = await new BS.GameObject({
                        name: `Tile_${lx}_${lz}`, parent: gridRoot,
                        localPosition: new BS.Vector3(lx * TILE_SIZE - offset, 0, lz * TILE_SIZE - offset)
                    }).Async();
                    await tile.AddComponent(new BS.BanterBox({ width: TILE_SIZE - 0.1, height: 0.4, depth: TILE_SIZE - 0.1 }));
                    await tile.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(TILE_SIZE - 0.1, 0.4, TILE_SIZE - 0.1) }));
                    const mat = await tile.AddComponent(new BS.BanterMaterial("Standard", "", new BS.Vector4(1, 1, 1, 1), BS.MaterialSide.Front, false, `Tile_${lx}_${lz}`));
                    const rb = await tile.AddComponent(new BS.BanterRigidbody({
                        useGravity: true,
                        isKinematic: true,
                        freezePositionX: true,
                        freezePositionZ: true,
                        freezeRotationX: true,
                        freezeRotationY: true,
                        freezeRotationZ: true
                    }));
                    tiles.push({ obj: tile, mat: mat, rb: rb, x: lx, z: lz, initialWorldPos: initialWorldPos, initialRotation: initialRotation });
                })(x, z));
            }
        }
        await Promise.all(tilePromises);
    }

    async function setupUI() {
        const uiAnchor = await new BS.GameObject({ name: "UIAnchor", localPosition: new BS.Vector3(0, GAME_HEIGHT + 12, 0) }).Async();
        const createDisplay = async (name, pos, rot) => {
            const panel = await new BS.GameObject({ name: name, parent: uiAnchor, localPosition: pos, localEulerAngles: rot }).Async();
            const textObj = await new BS.GameObject({ name: "Label", parent: panel, localPosition: new BS.Vector3(0, 4, 0) }).Async();
            const textComp = await textObj.AddComponent(new BS.BanterText({ text: "DROP GAME", fontSize: 12, color: new BS.Vector4(1, 1, 1, 1), horizontalAlignment: BS.HorizontalAlignment.Center }));
            const cube = await new BS.GameObject({ name: "ColorCube", parent: panel, localPosition: new BS.Vector3(0, -1, 0) }).Async();
            await cube.AddComponent(new BS.BanterBox({ width: 5, height: 5, depth: 5 }));
            const mat = await cube.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(1, 1, 1, 1) }));
            return { text: textComp, mat: mat, cube: cube };
        };
        ui.displays = [
            await createDisplay("DisplayN", new BS.Vector3(0, 0, 15), new BS.Vector3(0, 0, 0)),
            await createDisplay("DisplayS", new BS.Vector3(0, 0, -15), new BS.Vector3(0, 180, 0)),
            await createDisplay("DisplayE", new BS.Vector3(15, 0, 0), new BS.Vector3(0, 90, 0)),
            await createDisplay("DisplayW", new BS.Vector3(-15, 0, 0), new BS.Vector3(0, -90, 0))
        ];
    }

    async function setupAudio() {
        const audioRoot = await new BS.GameObject({ name: "Audio" }).Async();
        audio.tick = await audioRoot.AddComponent(new BS.BanterAudioSource({ volume: 0.3, loop: false, playOnAwake: false }));
    }

    function setupNetworking() {
        scene.On("space-state-changed", (e) => {
            if (e.detail.changes.some(c => c.property === STATE_KEY)) sync();
            updateScoreboard();
        });
        scene.On("user-left", (e) => {
            if (isHost() && e.detail.uid === gameState.currentHostUid) {
                const uids = Object.keys(scene.users).filter(id => id !== e.detail.uid).sort();
                if (uids.length > 0) updateState({ currentHostUid: uids[0], hostStealStartTime: 0, hostStealRequesterUid: null });
            }
            if (isHost() && e.detail.uid === gameState.hostStealRequesterUid) {
                updateState({ hostStealStartTime: 0, hostStealRequesterUid: null });
            }
        });
        sync();
        updateScoreboard();
    }

    async function sync() {
        const raw = scene.spaceState.public[STATE_KEY];
        if (!raw) return;
        gameState = JSON.parse(raw);
        updateVisuals();

        const hardTxt = await (await scene.Find("HardModeBtnText"))?.GetComponent(BS.CT.BanterText);
        if (hardTxt) hardTxt.text = `HARD: ${gameState.hardMode ? "ON" : "OFF"}`;

        updateButtonVisibility();
    }

    function updateButtonVisibility() {
        const userIsHost = isHost();
        hostOnlyButtons.forEach(btn => btn.SetActive(userIsHost));
    }

    function startSmoothReset() {
        if (isResettingSmoothly) return;
        isResettingSmoothly = true;

        const duration = 1500;
        const startTime = Date.now();

        tiles.forEach(tile => {
            tile.rb.isKinematic = true;
            tile.rb.velocity = new BS.Vector3(0, 0, 0);
            tile.rb.angularVelocity = new BS.Vector3(0, 0, 0);

            const p = tile.obj.transform.position;
            const r = tile.obj.transform.rotation;
            
            // Only reset if it fell down (Y differs significantly from start position)
            tile.needsReset = Math.abs(p.y - tile.initialWorldPos.y) > 0.1;
            
            if (tile.needsReset) {
                tile.resetStartPos = { x: p.x, y: p.y, z: p.z };
                tile.resetStartRot = { x: r.x, y: r.y, z: r.z, w: r.w };
            }
        });

        const animate = () => {
            const elapsed = Date.now() - startTime;
            const t = Math.min(1, elapsed / duration);

            tiles.forEach(tile => {
                if (!tile.needsReset || !tile.resetStartPos || !tile.initialWorldPos) return;

                const px = tile.resetStartPos.x + (tile.initialWorldPos.x - tile.resetStartPos.x) * t;
                const py = tile.resetStartPos.y + (tile.initialWorldPos.y - tile.resetStartPos.y) * t;
                const pz = tile.resetStartPos.z + (tile.initialWorldPos.z - tile.resetStartPos.z) * t;
                tile.rb.MovePosition(new BS.Vector3(px, py, pz));

                const rx = tile.resetStartRot.x + (tile.initialRotation.x - tile.resetStartRot.x) * t;
                const ry = tile.resetStartRot.y + (tile.initialRotation.y - tile.resetStartRot.y) * t;
                const rz = tile.resetStartRot.z + (tile.initialRotation.z - tile.resetStartRot.z) * t;
                const rw = tile.resetStartRot.w + (tile.initialRotation.w - tile.resetStartRot.w) * t;
                const mag = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
                tile.rb.MoveRotation(new BS.Quaternion(rx / mag, ry / mag, rz / mag, rw / mag));
            });

            if (t < 1 && (gameState.status === "RESETTING" || gameState.status === "LOBBY")) {
                requestAnimationFrame(animate);
            } else {
                isResettingSmoothly = false;
                
                // Snap the resetting tiles perfectly into position at the end
                tiles.forEach(tile => {
                    if (tile.needsReset && tile.initialWorldPos) {
                         tile.rb.MovePosition(new BS.Vector3(tile.initialWorldPos.x, tile.initialWorldPos.y, tile.initialWorldPos.z));
                         tile.rb.MoveRotation(new BS.Quaternion(tile.initialRotation.x, tile.initialRotation.y, tile.initialRotation.z, tile.initialRotation.w));
                    }
                });
            }
        };
        requestAnimationFrame(animate);
    }

    function updateVisuals() {
        const isDropped = gameState.status === "DROPPED";
        const isResetting = gameState.status === "RESETTING" || gameState.status === "LOBBY";

        tiles.forEach((tile, index) => {
            const colorIdx = Math.floor(seededRandom(gameState.seed + index) * COLORS.length);
            tile.mat.color = COLORS[colorIdx].vec;

            if (isDropped) {
                if (colorIdx !== gameState.targetColorIndex) {
                    tile.rb.isKinematic = false;
                }
            }
        });

        if (isResetting) {
            startSmoothReset();
        }
    }

    function updateScoreboard() {
        if (!scoreboardFalls || !scoreboardNormal || !scoreboardHard) return;
        const state = scene.spaceState.public;
        const players = [];
        Object.keys(state).forEach(key => {
            if (key.startsWith(USER_DATA_KEY_PREFIX)) { try { players.push(JSON.parse(state[key])); } catch (e) {} }
        });
        const updateBoard = (comp, title, sorted, formatter) => {
            let str = `<size=1.2><b>${title}</b></size>\n\n`;
            if (sorted.length === 0) str += "No records yet!";
            else sorted.forEach((p, i) => str += `${i+1}. ${p.name}: ${formatter(p)}\n`);
            comp.text = str;
        };
        updateBoard(scoreboardFalls, "MOST FALLS", [...players].sort((a, b) => b.falls - a.falls).slice(0, 50), p => p.falls);
        updateBoard(scoreboardNormal, "NORMAL SURVIVAL", [...players].filter(p => p.bestNormal > 0).sort((a, b) => b.bestNormal - a.bestNormal).slice(0, 50), p => (p.bestNormal / 1000).toFixed(1) + "s");
        updateBoard(scoreboardHard, "HARD SURVIVAL", [...players].filter(p => p.bestHard > 0).sort((a, b) => b.bestHard - a.bestHard).slice(0, 50), p => (p.bestHard / 1000).toFixed(1) + "s");
    }

    function updateUserStats(survivalTime, modeAtStart) {
        console.log(`DROP GAME: Updating stats. SurvivalTime: ${survivalTime}, ModeAtStart: ${modeAtStart}`);
        const uid = scene.localUser.uid;
        const key = USER_DATA_KEY_PREFIX + uid;
        let stats = { uid: uid, name: scene.localUser.name.replace(/<[^>]*>/g, ''), falls: 0, bestNormal: 0, bestHard: 0 };
        const raw = scene.spaceState.public[key];
        if (raw) { try { stats = JSON.parse(raw); } catch (e) {} }
        stats.falls++;
        stats.name = scene.localUser.name.replace(/<[^>]*>/g, '');
        if (survivalTime > 0) {
            if (modeAtStart) { if (survivalTime > stats.bestHard) stats.bestHard = survivalTime; }
            else { if (survivalTime > stats.bestNormal) stats.bestNormal = survivalTime; }
        }
        console.log(`DROP GAME: Saving stats for ${stats.name}:`, stats);
        scene.SetPublicSpaceProps({ [key]: JSON.stringify(stats) });
    }

    let lastTick = 0;
    function update() {
        const now = Date.now();

        // Survival timer logic
        const isGameFlowing = gameState.status === "SHOWING" || gameState.status === "DROPPED" || (gameState.status === "RESETTING" && gameState.round > 0);

        if (isLocalInArena && isGameFlowing) {
            if (gameStartTime === 0) {
                console.log("DROP GAME: Starting survival timer");
                gameStartTime = now;
                gameModeAtStart = gameState.hardMode;
            }
        } else if (!isGameFlowing) {
            // Only reset the timer if the game explicitly stops or enters initial pre-game reset
            if (gameStartTime !== 0) {
                console.log(`DROP GAME: Resetting survival timer (Game Stopped)`);
                gameStartTime = 0;
            }
        }

        const remaining = Math.max(0, Math.ceil((gameState.endTime - now) / 1000));
        let displayStr = "";
        let colorVisible = false;
        let colorVec = new BS.Vector4(1, 1, 1, 1);

        if (gameState.status === "SHOWING") {
            displayStr = remaining.toString();
            colorVisible = true;
            colorVec = COLORS[gameState.targetColorIndex].vec;
            if (!isMuted && remaining <= 3 && remaining > 0 && remaining !== lastTick) {
                audio.tick.PlayOneShotFromUrl("https://audiofiles.firer.at/mp3/Tick.mp3");
                lastTick = remaining;
            }
        } else if (gameState.status === "LOBBY") displayStr = "DROP GAME";
        else if (gameState.status === "DROPPED") displayStr = "!!!";
        else displayStr = "WAIT";

        ui.displays.forEach(d => {
            d.text.text = displayStr;
            d.mat.color = colorVec;
            d.cube.SetActive(colorVisible);
        });

        if (hostDisplay) {
            const hostUser = scene.users[gameState.currentHostUid];
            const requester = scene.users[gameState.hostStealRequesterUid];
            if (gameState.hostStealStartTime > 0 && requester) {
                const remainingHost = Math.max(0, Math.ceil((TIMINGS.HOST_STEAL_DURATION - (now - gameState.hostStealStartTime)) / 1000));
                hostDisplay.text = `<color=#ff0000>STEALING HOST: ${remainingHost}s</color>\n(Requested by: ${requester.name})`;
            } else {
                hostDisplay.text = hostUser ? `CURRENT HOST: ${hostUser.name}` : "NO HOST ASSIGNED";
            }
        }

        // Periodically update button visibility to ensure consistency
        updateButtonVisibility();

        if (isHost()) driveHostLogic(now);
    }

    function driveHostLogic(now) {
        if (gameState.hostStealStartTime > 0) {
            if (now - gameState.hostStealStartTime >= TIMINGS.HOST_STEAL_DURATION) {
                updateState({ currentHostUid: gameState.hostStealRequesterUid, hostStealStartTime: 0, hostStealRequesterUid: null });
            }
        }

        if (now < gameState.endTime) return;
        if (gameState.status === "SHOWING") updateState({ status: "DROPPED", endTime: now + (TIMINGS.DROPPED * 1000) });
        else if (gameState.status === "DROPPED") {
            const nextSeed = gameState.hardMode ? Math.floor(Math.random() * 999999) : gameState.seed;
            updateState({ status: "RESETTING", seed: nextSeed, endTime: now + (TIMINGS.RESETTING * 1000) });
        } else if (gameState.status === "RESETTING") startNextRound(gameState.round + 1, gameState.seed);
    }

    function startNextRound(roundNum, seed) {
        const speedScale = gameState.hardMode ? 0.6 : 0.35;
        const duration = Math.max(1.8, gameState.initialCountdown - (roundNum * speedScale));

        // Calculate available colors on the board for this seed
        const availableColors = new Set();
        for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
            availableColors.add(Math.floor(seededRandom(seed + i) * COLORS.length));
        }
        const colorsList = Array.from(availableColors);

        // Pick one of the available colors
        const targetColorIndex = colorsList.length > 0
            ? colorsList[Math.floor(Math.random() * colorsList.length)]
            : Math.floor(Math.random() * COLORS.length);

        updateState({ status: "SHOWING", round: roundNum, seed: seed, targetColorIndex: targetColorIndex, endTime: Date.now() + (duration * 1000) });
    }

    function updateState(patch) {
        const next = { ...gameState, ...patch };
        scene.SetPublicSpaceProps({ [STATE_KEY]: JSON.stringify(next) });
    }

    if (window.BS) init();
    else window.addEventListener("bs-loaded", init);
})();
